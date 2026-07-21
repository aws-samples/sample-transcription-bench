import torch
import soundfile as sf
import io, json, os, tempfile, urllib.request


def model_fn(model_dir):
    from qwen_asr import Qwen3ASRModel
    print(f"enter :: model_fn - inference.py")
    return Qwen3ASRModel.from_pretrained(
        model_dir,
        dtype=torch.float32,
        device_map="cuda",
        max_new_tokens=256,
    )


def _load_audio(audio_bytes: bytes):
    audio, sr = sf.read(io.BytesIO(audio_bytes), dtype="float32")
    return {"audio": audio, "sr": sr}


def input_fn(request_body, request_content_type):
    """
    Accepts either:
      - application/json: {"url": "<presigned S3 URL>"}  -> downloads audio from URL.
        This avoids the ~6 MB SageMaker InvokeEndpoint sync payload limit for
        large WAVs.
      - audio/wav (or anything else): raw audio bytes (legacy path).
    """
    print(f"request_content_type is {request_content_type} :: input_fn - inference.py")
    if request_content_type == "application/json":
        if isinstance(request_body, (bytes, bytearray)):
            request_body = request_body.decode("utf-8")
        payload = json.loads(request_body)
        url = payload.get("url")
        if not url:
            raise ValueError("JSON payload missing required 'url' field")
        print(f"downloading audio from presigned URL :: input_fn - inference.py")
        with urllib.request.urlopen(url) as resp:
            audio_bytes = resp.read()
        print(f"downloaded {len(audio_bytes)} bytes :: input_fn - inference.py")
        return _load_audio(audio_bytes)

    # Legacy raw-bytes path. Caps out around 6 MB due to SageMaker payload limit.
    print(f"reading raw bytes :: input_fn - inference.py")
    return _load_audio(request_body)


def predict_fn(input_data, model):
    print(f"model is {model} :: predict_fn - inference.py")
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        print(f"input file suffix matched to .wav :: predict_fn - inference.py")
        sf.write(f, input_data["audio"], input_data["sr"])
        tmp_path = f.name
        print(f"invoke model transcribe :: predict_fn - inference.py")
        results = model.transcribe(audio=tmp_path)
        print(f"raw model transcribe result {results[0]} :: predict_fn - inference.py")
        os.unlink(tmp_path)
        return {"language": results[0].language, "text": results[0].text}


def output_fn(prediction, accept):
    print(f"enter :: output_fn - inference.py")
    return json.dumps(prediction), "application/json"
