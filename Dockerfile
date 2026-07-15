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

# Browser for TikTokApi (driven by patchright, the leak-patched Playwright
# fork main.py aliases in). Google Chrome on amd64: noticeably better bot
# detection resistance than the bundled Chromium. Google ships no linux/arm64
# Chrome build, so arm64 installs patchright's Chromium instead.
# config.py auto-detects google-chrome and falls back to Chromium, so each
# arch carries only its one browser.
RUN if [ "$(dpkg --print-architecture)" = "amd64" ]; then \
      apt-get update && \
      apt-get install -y --no-install-recommends wget && \
      wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && \
      apt-get install -y /tmp/chrome.deb && \
      rm /tmp/chrome.deb && \
      rm -rf /var/lib/apt/lists/*; \
    else \
      patchright install chromium; \
    fi

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
