# The analysis worker (ojo_replay.worker) for an NVIDIA GPU, e.g. AWS Batch on
# g6.xlarge (infra/analysis_worker.tf). Build with ./build.sh, which stages the
# code, our hit classifier, the model weights and the pinned WASB source.
FROM pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg curl libgl1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Model weights and vendored WASB live where the pipeline looks for them.
COPY cache/ /app/.cache/
COPY models/ /app/models/
COPY ojo_replay/ /app/ojo_replay/

ENV PYTHONUNBUFFERED=1 PYTHONWARNINGS=ignore
CMD ["python", "-m", "ojo_replay.worker", "--once"]
