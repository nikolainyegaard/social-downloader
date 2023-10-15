from tikapi import TikAPI, ValidationException, ResponseException
import os
import json
import time
import random
import requests
from requests.exceptions import RequestException
from tiktok_downloader import snaptik, mdown, tikdown

def api_request(music_id, cursor, api):
    base_delay = 5
    max_delay = 60
    max_retries = 9999
    
    retries = 0
    while retries <= max_retries:
        if cursor:
            response = api.public.music(id=music_id, cursor=cursor)
        else:
            response = api.public.music(id=music_id)

        if response.status_code != 403:
            return response
        else:
            delay = min(max_delay, (2 ** retries) + random.uniform(0, 1) * 0.1)
            print(f"Rate limited. Retrying in {delay:.2f} seconds...")
            time.sleep(delay)
            retries += 1
    
    raise Exception("Too many retry attempts")

def get_music_posts(music_id, api):
    try:
        all_posts = []
        cursor = None
        counter = 0
        zero_items_counter = 0
        zero_items_counter_max = 3

        while True:
            response = api_request(music_id=music_id, cursor=cursor, api=api)
            time.sleep(random.uniform(30, 90))
            response_json = response.json()

            items = response_json.get('itemList')
            print(f'Retrieved {len(items) if items else 0} items')
            try:
                counter += len(items)
            except:
                pass
            print(f"Total items: {counter}")

            if items:
                all_posts.extend(items)
                zero_items_counter = 0
            else:
                zero_items_counter += 1
                print(f'No items retrieved. Attempt {zero_items_counter}/{zero_items_counter_max}.')
                if zero_items_counter >= zero_items_counter_max:
                    print(f'Exiting loop after {zero_items_counter_max} attempt(s) with 0 items.')
                    break
                else:
                    print('Retrying...')
                    time.sleep(random.uniform(3,10))
                    continue
                                
            cursor = response_json.get('cursor')
            if not cursor or int(cursor) > 5000:
                print('No cursor found. Exiting loop.')
                break

            print(f'Next cursor: {cursor}')

        return {'itemList': all_posts}

    except ValidationException as e:
        print(e, e.field)
        return {'itemList': all_posts}

    except ResponseException as e:
        print(e, e.response.status_code)
        return {'itemList': all_posts}


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
                try:
                    video_data[0].download(os.path.join(author_folder, f"{video_id}.mp4"))
                except:
                    print("Index error")
                    return
                print("Download successful!")
                return
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

def main():
    tikapi_key = '7dwWrHNFgSobFJ0UTfCMo5Tw1WyyiqEQjrv4YUCj0MHQF7Ka'
#    tikapi_key = 'bMIMXdol1icOWY7O53zZQ1MM8rSVK3NzU1KO1QfOEpwF539W'
    music_id = '7192626048159288106'
    api = TikAPI(tikapi_key)
    while True:
        posts = get_music_posts(music_id, api)
        with open('previously_downloaded_videos.txt', 'r') as file:
            downloaded_videos = file.read().splitlines()
        for post in posts['itemList']:
            video_id = post['id']
            if video_id not in downloaded_videos:
                author_folder = os.path.join('Videos', f"@{post['author']['uniqueId']}")
                authorName = post['author']['uniqueId']
                os.makedirs(author_folder, exist_ok=True)
                download_video(author_folder, video_id, authorName)
                with open('previously_downloaded_videos.txt', 'a') as file:
                    file.write(video_id + '\n')
        print("\nAll downloads completed. Sleeping for 6 hours...")
        time.sleep(21600)

main()