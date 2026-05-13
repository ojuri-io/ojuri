# Fraud Investigation Agent (FIA) Service Dockerfile
FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN mkdir -p /app/models /app/.hf-cache
ENV HF_HOME=/app/.hf-cache
ENV PYTHONPATH=/app

CMD ["python", "-m", "src.main"]
