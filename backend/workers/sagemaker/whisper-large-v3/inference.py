"""
SageMaker BYOC inference handler for Distil-Whisper Large v3.

Distil-Whisper is a distilled variant of OpenAI Whisper Large v3 with a
2-layer decoder (vs. 32 in the original). It is a drop-in replacement in
the HuggingFace `AutoModelForSpeechSeq2Seq` API and uses the same
processor, tokenizer, and generate parameters as Whisper, so this
handler works unchanged for either model — swap the HF repo ID in
`scripts/upload-sagemaker-artifacts.sh` to switch back to
`openai/whisper-large-v3` if multilingual coverage is needed later.

Mirrors the pattern of the Qwen3 BYOC handler:
  - model.tar.gz contains the full model weights at the root
    (downloaded from HuggingFace `distil-whisper/distil-large-v3` at
    packaging time, never at endpoint start) plus this `code/` directory.
  - The PyTorch Inference DLC auto-discovers `code/inference.py` and
    `code/requirements.txt` via SAGEMAKER_PROGRAM=inference.py.
  - We expose model_fn / input_fn / predict_fn / output_fn.

Wire-protocol (matches Qwen handler so the worker Lambda treats both
endpoints identically):

  Request  : application/json
             {"url": "<presigned S3 URL to .wav>"}
             (Legacy raw audio/wav body is also accepted.)

  Response : application/json
             {"language": "<detected lang or 'en' if forced>",
              "text": "<transcription>"}
"""

import io
import json
import os
import tempfile
import urllib.request

import numpy as np
import soundfile as sf
import torch
import torchaudio.functional as AF
from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor, pipeline


# Distil-Whisper (like Whisper) is trained on 16 kHz mono audio. In
# principle the HF ASR pipeline resamples when we pass a numpy array
# with a non-matching `sampling_rate`, but we resample explicitly in
# `_decode_audio` instead. This avoids a silent-corruption failure mode
# we hit on this DLC image where the pipeline's resample codepath did
# not convert incoming 44.1 kHz WAVs down to 16 kHz — the model then
# happily decoded the mel-warped features into confident-sounding
# nonsense ("The stale smell of old beer lingers" ->
# "The sky spade eat by youngers"). Doing the resample here means the
# model can never see anything other than 16 kHz mono float32.
TARGET_SAMPLE_RATE = 16000


def model_fn(model_dir):
    """
    Load Distil-Whisper Large v3 from the local model_dir baked into
    model.tar.gz.

    Returns a HF `pipeline("automatic-speech-recognition", ...)` so
    predict_fn just calls the pipeline. The pipeline transparently
    handles chunking for audio longer than the chunk window when
    chunk_length_s is set.
    """
    print("model_fn :: loading distil-whisper-large-v3 from", model_dir)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    torch_dtype = torch.float16 if device == "cuda" else torch.float32

    model = AutoModelForSpeechSeq2Seq.from_pretrained(
        model_dir,
        torch_dtype=torch_dtype,
        low_cpu_mem_usage=True,
        use_safetensors=True,
    )
    model.to(device)

    processor = AutoProcessor.from_pretrained(model_dir)

    pipe = pipeline(
        "automatic-speech-recognition",
        model=model,
        tokenizer=processor.tokenizer,
        feature_extractor=processor.feature_extractor,
        torch_dtype=torch_dtype,
        device=device,
        # distil-large-v3 is tuned for a 25 s chunk window (see the HF
        # model card). With timestamps=True the pipeline stitches chunk
        # outputs into a single transcript.
        chunk_length_s=25,
        return_timestamps=True,
    )
    print("model_fn :: pipeline ready on", device)
    return pipe


def _decode_audio(audio_bytes: bytes):
    """
    Decode WAV bytes to (np.float32 mono @ 16 kHz).

    Handles any source sample rate (8k, 16k, 22.05k, 44.1k, 48k, 96k, ...)
    and any channel count. Same guarantee ffmpeg gave us in the pre-BYOC
    HF DLC handler, but done in pure Python via soundfile + torchaudio so
    we don't need ffmpeg on the container's PATH.
    """
    audio, src_sr = sf.read(io.BytesIO(audio_bytes), dtype="float32", always_2d=False)

    # Collapse to mono — Whisper expects single-channel input.
    if audio.ndim == 2:
        audio = audio.mean(axis=1)

    # Resample to 16 kHz if needed. Polyphase resampling in torchaudio
    # is fast, high-quality, and format-agnostic, so we always route
    # through it rather than special-casing common source rates.
    if src_sr != TARGET_SAMPLE_RATE:
        audio_tensor = torch.from_numpy(audio)
        audio_tensor = AF.resample(audio_tensor, src_sr, TARGET_SAMPLE_RATE)
        audio = audio_tensor.numpy().astype(np.float32, copy=False)

    return audio, TARGET_SAMPLE_RATE


def input_fn(request_body, request_content_type):
    """
    Accept the same two shapes the Qwen handler does so the worker Lambda
    doesn't need a model-specific code path:

      - application/json  : {"url": "<presigned S3 URL>"}
                            We fetch the bytes server-side, which keeps
                            payloads under SageMaker's ~6 MB sync limit.
      - audio/wav (etc.)  : raw bytes (legacy path)
    """
    print("input_fn :: content_type=", request_content_type)
    if request_content_type == "application/json":
        if isinstance(request_body, (bytes, bytearray)):
            request_body = request_body.decode("utf-8")
        payload = json.loads(request_body)
        url = payload.get("url")
        if not url:
            raise ValueError("JSON payload missing required 'url' field")
        print("input_fn :: downloading audio from presigned URL")
        with urllib.request.urlopen(url) as resp:  # nosec - URL provided by caller, presigned
            audio_bytes = resp.read()
        print(f"input_fn :: downloaded {len(audio_bytes)} bytes")
        audio, sr = _decode_audio(audio_bytes)
        return {"audio": audio, "sampling_rate": sr}

    # Legacy raw-bytes path. Caps out around 6 MB due to SageMaker payload
    # limit, so the JSON+URL form is preferred.
    print("input_fn :: reading raw bytes")
    audio, sr = _decode_audio(request_body)
    return {"audio": audio, "sampling_rate": sr}


def predict_fn(input_data, model):
    """
    Run the pipeline. Accepts `{"raw": np.ndarray, "sampling_rate": int}`
    directly; the pipeline resamples to 16 kHz as needed.

    Note on generate_kwargs: earlier versions of this handler passed the
    Whisper Large v3 anti-repetition suite (`no_repeat_ngram_size`,
    `compression_ratio_threshold`, `logprob_threshold`, etc.). Those were
    calibrated for Whisper Large's 32-layer decoder pathology and are
    actively harmful for Distil-Whisper's 2-layer decoder — the ngram
    blocker vetoes legitimate English trigrams, and the compression /
    logprob thresholds are too tight for distil's naturally more
    compressed and slightly lower-confidence output, so almost every
    chunk gets flagged as "hallucinated" and re-decoded to junk.
    Distil-Whisper's model card recommends running the pipeline with
    defaults, which is what we do here.

    `language="en"` is set because Distil-Whisper Large v3 is English-only
    and gives noticeably better results with the language pinned rather
    than relying on the (English-tilted) auto-detect codepath.
    """
    print("predict_fn :: transcribing")
    result = model(
        {"raw": input_data["audio"], "sampling_rate": input_data["sampling_rate"]},
        generate_kwargs={
            "task": "transcribe",
            "language": "en",
        },
    )
    text = result.get("text", "")
    # The HF pipeline can return a language hint when `language` is left
    # unset; otherwise we report 'auto'.
    language = "auto"
    chunks = result.get("chunks") or []
    if chunks and isinstance(chunks[0], dict):
        language = chunks[0].get("language", language)
    print(f"predict_fn :: text_chars={len(text)} language={language}")
    return {"language": language, "text": text}


def output_fn(prediction, accept):
    print("output_fn :: emitting", accept)
    return json.dumps(prediction), "application/json"
