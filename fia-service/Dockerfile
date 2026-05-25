# Ojuri FIA service Dockerfile
FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Drop privileges — the root RDA and PAA Dockerfiles already run as
# `nodejs:1001`; FIA shouldn't be the only service that stays root.
RUN groupadd --gid 1001 fia && \
    useradd --uid 1001 --gid 1001 --shell /bin/bash --create-home fia && \
    mkdir -p /app/models /app/.hf-cache && \
    chown -R fia:fia /app
USER fia

ENV HF_HOME=/app/.hf-cache
ENV PYTHONPATH=/app

CMD ["python", "-m", "src.main"]
