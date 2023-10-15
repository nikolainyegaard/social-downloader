from TikTokApi import TikTokApi
import asyncio
import os
import time
from requests.exceptions import RequestException
from tiktok_downloader import snaptik, mdown, tikdown
from datetime import datetime, timedelta

ms_token = os.environ.get("ms_token", None)

with open('sound_id.txt', 'r') as file:
    sound_id = file.read().strip()


async def GetVideosFromSound():
    with open('current_videos.txt', 'w') as file:
        pass
    async with TikTokApi() as api:
        print('[START]')
        print(f"[{datetime.now().strftime('%H:%M:%S')}] Creating API session. Please wait...")
        await api.create_sessions(ms_tokens=[ms_token], num_sessions=1, sleep_after=3)
        video_array = []
        print(f"[{datetime.now().strftime('%H:%M:%S')}] Fetching videos from sound {sound_id}...")
        async for video in api.sound(id=sound_id).videos(count=2000):
            video_array.append(video.id)
            with open('current_videos.txt', 'a') as file:
                file.write(video.id + '\n')
    return video_array


async def GetVideosInfo(new_videos):
    total_videos = len(new_videos)
    counter = 0
    video_array = []
    async with TikTokApi() as api:
        await api.create_sessions(ms_tokens=[ms_token], num_sessions=1, sleep_after=3)
        for video_id in new_videos:
            counter += 1
            video_url = f"https://www.tiktok.com/@user/video/{video_id}"
            video = api.video(url=video_url)
            try:
                video_info = await video.info()
                video_array.append(video_info)
                print(f"[{datetime.now().strftime('%H:%M:%S')}] Processed {counter} of {total_videos}")
            except:
                print(f"[{datetime.now().strftime('%H:%M:%S')}] Error with video {video_url}")
    print(f"[{datetime.now().strftime('%H:%M:%S')}] Successfully fetched {len(video_array)} out of {len(new_videos)} videos.")
    return video_array


def CheckDeletedVideos(video_count):
    timestamp = datetime.now().strftime('%H:%M:%S')
    counter = 0
    append_videos = []

    with open('last.txt', 'r') as file:    
        video_count_old = int(file.read().splitlines()[-1])
    if video_count < (video_count_old * 0.95):
        return f"\n[{timestamp}] No new deleted videos found."
    
    with open('downloaded_automatically.txt', 'r') as file:
        downloaded_videos_auto = file.read().splitlines()
    with open('downloaded_manually.txt', 'r') as file:
        downloaded_videos_manual = file.read().splitlines()
    with open('current_videos.txt', 'r') as file:
        current_videos = file.read().splitlines()
    with open('deleted_videos.txt', 'r') as file:
        deleted_videos = file.read().splitlines()

    for video_id in downloaded_videos_auto:
        if video_id not in current_videos and video_id not in deleted_videos and not video_id in downloaded_videos_manual:
                counter += 1
                append_videos.append(video_id)

    if counter > 0:
        with open('deleted_videos.txt', 'a') as file:
            file.write('\n' + f'[{timestamp}]' + '\n')
        for video_id in append_videos:
                with open('deleted_videos.txt', 'a') as file:
                    file.write(video_id + '\n')
        if counter == 1:
                video_plural = "video"
        else:
                video_plural = "videos"
        return f"\n[{timestamp}] Added {counter} {video_plural} to deleted_videos.txt."
    else:
        return f"\n[{timestamp}] No new deleted videos found."        


def DownloadVideo(author_folder, video_id, authorName):
    video_url = f"https://www.tiktok.com/@user/video/{video_id}"
    
    download_services = [mdown, tikdown, snaptik]
    max_retries = 3
    timeout_seconds = 30
    
    for attempt in range(max_retries):
        for download_service in download_services:
            try:
                print(f"\n[{datetime.now().strftime('%H:%M:%S')}] Downloading video {video_id} from @{authorName} using {download_service.__name__}...")
                video_data = time_limited_request(video_url, download_service, timeout_seconds)
                try:
                    video_data[0].download(os.path.join(author_folder, f"{video_id}.mp4"))
                except:
                    print(f"[{datetime.now().strftime('%H:%M:%S')}] Index error")
                    return
                print(f"[{datetime.now().strftime('%H:%M:%S')}] Download successful!")
                return
            except (RequestException, TimeoutError) as e:
                print(f"[{datetime.now().strftime('%H:%M:%S')}] Failed using {download_service.__name__}: {str(e)}")
                print(f"[{datetime.now().strftime('%H:%M:%S')}] Trying next service...")
        
        if attempt < max_retries - 1:
            sleep_time = 2 ** attempt
            print(f"[{datetime.now().strftime('%H:%M:%S')}] All services failed. Retrying all services in {sleep_time} seconds...")
            time.sleep(sleep_time)
    
    print(f"[{datetime.now().strftime('%H:%M:%S')}] Failed to download after several attempts with all services.")
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


def GetNextCycle(hours, minutes):
    if minutes == 45:
        return datetime.strptime(f"{(hours+1)%24}:{00}", "%H:%M").time()
    elif minutes % 15 == 0:
        return datetime.strptime(f"{hours}:{minutes+15}", "%H:%M").time()
    else:
        if minutes // 15 == 0:
            return datetime.strptime(f"{hours%24}:{30}", "%H:%M").time()
        elif minutes // 15 == 1:
            return datetime.strptime(f"{hours%24}:{45}", "%H:%M").time()
        elif minutes // 15 == 2:
            return datetime.strptime(f"{(hours+1)%24}:{00}", "%H:%M").time()
        elif minutes // 15 == 3:
            return datetime.strptime(f"{(hours+1)%24}:{15}", "%H:%M").time()


def EvaluateRatelimit(video_count):
    with open('last.txt', 'r') as file:    
        video_count_old = int(file.read().splitlines()[-1])
    if video_count < (video_count_old * 0.95):
        return True
    else:
        return False


def Main():
    video_ids = asyncio.run(GetVideosFromSound())
    ratelimit = EvaluateRatelimit(len(video_ids))
    deleted_response = CheckDeletedVideos(len(video_ids))
    print(f"[{datetime.now().strftime('%H:%M:%S')}] Total videos fetched: {len(video_ids)}")
    with open('last.txt', 'a') as file:
        file.write('\n' + str(len(video_ids)))
    with open('downloaded_automatically.txt', 'r') as file:
        downloaded_automatically = file.read().splitlines()
    with open('downloaded_manually.txt', 'r') as file:
        downloaded_manually = file.read().splitlines()
    new_videos = []
    for video_id in video_ids:
        if video_id not in downloaded_automatically and video_id not in downloaded_manually:
            new_videos.append(video_id)
    if len(new_videos) == 0:
        print(f"[{datetime.now().strftime('%H:%M:%S')}] No new videos found.")
        print(deleted_response)
        return ratelimit
    else:
        print(f"[{datetime.now().strftime('%H:%M:%S')}] New videos found: {len(new_videos)}")
        print(deleted_response)
    videos = asyncio.run(GetVideosInfo(new_videos))
    for video in videos:
        authorName = video['author']
        video_id = video['id']
        author_folder = os.path.join('../../Videos/TikTok', f"@{authorName}")
        os.makedirs(author_folder, exist_ok=True)
        DownloadVideo(author_folder, video_id, authorName)
        with open('downloaded_automatically.txt', 'a') as file:
            file.write(video_id + '\n')
    return ratelimit

print(f"[{datetime.now().strftime('%H:%M:%S')}] Starting program...\n")


while True:
    status = Main()
    now = datetime.now()
    nextCycle = datetime.combine(datetime.now().date(), GetNextCycle(now.hour, now.minute))    
    if status:
        nextCycle += timedelta(minutes=60)
        print(f"[{datetime.now().strftime('%H:%M:%S')}] Ratelimit likely. Sleeping until {nextCycle.strftime('%H:%M')}...")
    else:
        nextCycle += timedelta(minutes=15)
        print(f"[{datetime.now().strftime('%H:%M:%S')}] Sleeping until {nextCycle.strftime('%H:%M')}...")
    print('[END]')
    if nextCycle < now:
        nextCycle += timedelta(days=1)
    difference = (nextCycle - now).total_seconds()
    time.sleep(difference)
    print('\n\n')