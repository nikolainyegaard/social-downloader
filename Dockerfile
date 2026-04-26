FROM python:3.12-slim

# ffmpeg  — required by yt-dlp to merge streams and embed metadata, and by
# photo_converter/thumbnailer for AVIF encoding (libaom-av1 is included in
# the standard Debian Bookworm ffmpeg package).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Install Chromium (used by TikTokApi) plus all OS-level dependencies it needs
RUN playwright install chromium --with-deps

# Install Google Chrome on amd64 for better bot detection resistance.
# On arm64 (e.g. Apple Silicon) Chrome isn't available; falls back to Playwright Chromium.
RUN if [ "$(dpkg --print-architecture)" = "amd64" ]; then \
      apt-get update && \
      apt-get install -y --no-install-recommends wget && \
      wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && \
      apt-get install -y /tmp/chrome.deb && \
      rm /tmp/chrome.deb && \
      rm -rf /var/lib/apt/lists/*; \
    fi

COPY . .

# Persistent volumes are mounted here at runtime
RUN mkdir -p /app/data /app/media

ARG BUILD_VERSION=dev
ENV PYTHONUNBUFFERED=1 \
    DATA_DIR=/app/data \
    MEDIA_DIR=/app/media \
    WEB_PORT=5000 \
    APP_VERSION=${BUILD_VERSION}

EXPOSE 5000

CMD ["python", "app/main.py"]
