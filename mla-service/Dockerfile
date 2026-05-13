# Model Learning Agent (MLA) Service Dockerfile
FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for better caching
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy source code
COPY . .

# Create directories for models and data
RUN mkdir -p /app/models /app/data

# Set Python path
ENV PYTHONPATH=/app

# Default command
CMD ["python", "-m", "src.main"]
