FROM python:3.12-slim

# ffmpeg: yt-dlp stream merging, metadata embedding, AVIF encoding
# libaom-av1 is included in the standard Debian Bookworm ffmpeg package
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Install Playwright Chromium and all OS-level runtime dependencies.
# playwright install --with-deps runs apt-get internally without cleaning up; the
# explicit rm clears /var/lib/apt/lists/ within the same layer so it is never committed.
RUN playwright install chromium --with-deps && rm -rf /var/lib/apt/lists/*

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
