"""
SageMaker BYOC inference handler for NVIDIA Parakeet TDT 0.6B v3.

Parakeet is a NeMo model (not a HuggingFace transformers model), so
loading goes through `nemo_asr.models.ASRModel.restore_from(<.nemo>)`
rather than `AutoModelForSpeechSeq2Seq.from_pretrained(...)`. Everything
else follows the same BYOC contract as the Whisper and Qwen handlers so
the worker Lambda (`backend/workers/sagemaker/handler.ts`) can invoke
this endpoint identically:

  Request  : application/json  {"url": "<presigned S3 URL to .wav>"}
             (raw audio/wav body also accepted for local testing)

  Response : application/json  {"language": "en", "text": "<transcript>"}

Packaging (see `scripts/upload-sagemaker-artifacts.sh`):
  model.tar.gz root: parakeet-tdt-0.6b-v3.nemo  (from HF `nvidia/parakeet-tdt-0.6b-v3`)
  model.tar.gz code/: this file + requirements.txt

The PyTorch DLC installs `code/requirements.txt` on container startup and
auto-discovers `code/inference.py` via `SAGEMAKER_PROGRAM=inference.py`
(set on the CfnModel by `infra/lib/ai/sagemaker-byoc-endpoints.ts`).

Container image: we deliberately pin Parakeet to the older
`pytorch-inference:2.5.1-gpu-py311` DLC that NVIDIA tests against —
NeMo 2.x's dep graph resolves cleanly there, and on the newer py312
image we saw torchaudio/torchvision version conflicts during install.
See the per-model `imageUri` override in the CDK construct.
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


# Parakeet TDT 0.6B v3 is trained on 16 kHz mono audio; anything else
# has to be resampled first. Same defense we apply in the Whisper
# handler after the silent-corruption bug we hit there.
TARGET_SAMPLE_RATE = 16000


def model_fn(model_dir):
    """
    Load the .nemo checkpoint. The tarball has the .nemo file at the
    root, so we scan `model_dir` for the first `*.nemo` we find.
    """
    # Deferred import — NeMo pulls in a lot at import time, and delaying
    # it lets us see clearer errors in CloudWatch if requirements.txt
    # installed something incompatible.
    import nemo.collections.asr as nemo_asr

    print(f"model_fn :: scanning {model_dir} for .nemo checkpoint")
    for fname in os.listdir(model_dir):
        if fname.endswith(".nemo"):
            nemo_path = os.path.join(model_dir, fname)
            print(f"model_fn :: restoring from {nemo_path}")
            model = nemo_asr.models.ASRModel.restore_from(nemo_path)
            device = "cuda" if torch.cuda.is_available() else "cpu"
            model = model.to(device)
            model.eval()
            print(f"model_fn :: ready on {device}")
            return model
    raise FileNotFoundError(f"No .nemo file found in model_dir {model_dir}")


def _decode_audio(audio_bytes: bytes):
    """
    Decode WAV bytes to (np.float32 mono @ 16 kHz).

    Handles any source sample rate / channel count. Same routine as the
    Whisper handler — Parakeet expects 16 kHz mono float32 the same way
    Whisper does.
    """
    audio, src_sr = sf.read(io.BytesIO(audio_bytes), dtype="float32", always_2d=False)

    if audio.ndim == 2:
        audio = audio.mean(axis=1)

    if src_sr != TARGET_SAMPLE_RATE:
        audio_tensor = torch.from_numpy(audio)
        audio_tensor = AF.resample(audio_tensor, src_sr, TARGET_SAMPLE_RATE)
        audio = audio_tensor.numpy().astype(np.float32, copy=False)

    return audio


def input_fn(request_body, request_content_type):
    """
    Two shapes, matching the Whisper and Qwen handlers so the worker
    Lambda has one code path for all three BYOC ASR endpoints:

      - application/json         {"url": "<presigned S3 URL>"}
                                 Preferred; bypasses the 6 MB InvokeEndpoint
                                 payload limit.
      - audio/{wav,x-wav,wave}   raw WAV bytes (used only for local
        or application/octet-stream  testing / notebook invocations)
    """
    print(f"input_fn :: content_type={request_content_type}")
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
        return _decode_audio(audio_bytes)

    if request_content_type in (
        "audio/wav",
        "audio/x-wav",
        "audio/wave",
        "application/octet-stream",
    ):
        print(f"input_fn :: reading raw bytes ({len(request_body)} bytes)")
        return _decode_audio(request_body)

    raise ValueError(f"Unsupported content_type: {request_content_type}")


def predict_fn(input_data, model):
    """
    Parakeet's `model.transcribe(...)` expects a list of file paths, so
    we serialize the decoded audio back to a temporary WAV file (already
    at 16 kHz mono after `_decode_audio`), transcribe, and clean up.
    """
    print("predict_fn :: transcribing")
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        sf.write(f, input_data, TARGET_SAMPLE_RATE)
        tmp_path = f.name

    try:
        results = model.transcribe([tmp_path])
    finally:
        os.unlink(tmp_path)

    # `transcribe` returns a list of Hypothesis objects (or plain strings
    # on very old NeMo builds); support both.
    if not results:
        text = ""
    else:
        first = results[0]
        text = first.text if hasattr(first, "text") else str(first)

    print(f"predict_fn :: text_chars={len(text)}")
    return {"language": "en", "text": text}


def output_fn(prediction, accept):
    print(f"output_fn :: emitting {accept}")
    return json.dumps(prediction), "application/json"
