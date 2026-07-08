FROM python:3.12-slim-bookworm

# ffmpeg: yt-dlp stream merging, metadata embedding, AVIF encoding
# Playwright Chromium runtime deps installed here so this layer is cached by Docker
# and playwright install chromium can run without --with-deps (no internal apt-get).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
      libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
      libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2 \
      fonts-liberation xvfb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

RUN playwright install chromium

COPY . .

RUN mkdir -p /app/data /app/media

ARG BUILD_VERSION=dev
ENV PYTHONUNBUFFERED=1 \
    DATA_DIR=/app/data \
    MEDIA_DIR=/app/media \
    WEB_PORT=5000 \
    APP_VERSION=${BUILD_VERSION}

EXPOSE 5000

CMD ["python", "app/main.py"]
