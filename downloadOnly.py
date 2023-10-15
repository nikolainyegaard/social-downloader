from tikapi import TikAPI, ValidationException, ResponseException
import os
import json
import time
import random
import requests
from requests.exceptions import RequestException
from tiktok_downloader import snaptik, mdown, tikdown

input_link = input("Link: ")

video_id = input_link.split("/")[5].split("?")[0]
authorName = input_link.split("/")[3].strip("@")
author_folder = os.path.join('../../Videos/TikTok', f"@{authorName}/Extra")

def download_video(author_folder, video_id, authorName):
    video_url = f"https://www.tiktok.com/@user/video/{video_id}"
    
    download_services = [mdown, tikdown, snaptik]
    max_retries = 3
    timeout_seconds = 30
    
    for attempt in range(max_retries):
        for download_service in download_services:
            try:
                print(f"Downloading video {video_id} from @{authorName} using {download_service.__name__}...")
                video_data = time_limited_request(video_url, download_service, timeout_seconds)
                os.makedirs(author_folder, exist_ok=True)
                video_data[0].download(os.path.join(author_folder, f"{video_id}.mp4"))
                print("Download successful!")
                return "Success"
            except (RequestException, TimeoutError) as e:
                print(f"Failed using {download_service.__name__}: {str(e)}")
                print("Trying next service...")
        
        if attempt < max_retries - 1:
            sleep_time = 2 ** attempt
            print(f"All services failed. Retrying all services in {sleep_time} seconds...")
            time.sleep(sleep_time)
    
    print("Failed to download after several attempts with all services.")
    return

def time_limited_request(video_url, download_service, timeout_seconds):
    from threading import Thread
    
    class DownloadThread(Thread):
        def __init__(self, url, service):
            Thread.__init__(self)
            self.url = url
            self.service = service
            self.result = None
            self.error = None
        
        def run(self):
            try:
                self.result = self.service(self.url)
            except Exception as e:
                self.error = e
    
    download_thread = DownloadThread(video_url, download_service)
    download_thread.start()
    download_thread.join(timeout=timeout_seconds)
    
    if download_thread.is_alive():
        raise TimeoutError(f"{download_service.__name__} took too long to respond.")
    if download_thread.error is not None:
        raise download_thread.error
    
    return download_thread.result

def main(video_id):
    with open('downloaded_manually.txt', 'r') as file:
            downloaded_videos = file.read().splitlines()
    if video_id not in downloaded_videos:
        status = download_video(author_folder, video_id, authorName)
        if status == "Success":
            with open('downloaded_manually.txt', 'a') as file:
                file.write(video_id + '\n')
    else:
        print(f"Video with ID {video_id} has been downloaded already. Exiting program.")

main(video_id)