from TikTokApi import TikTokApi
import asyncio
import os
import time
import json
from requests.exceptions import RequestException
from tiktok_downloader import snaptik, mdown, tikdown
from datetime import datetime, timedelta

with open("./last.txt", "a") as file:
    pass

ms_token = os.environ.get("ms_token", None)

with open('sound_id.txt', 'r') as file:
    sound_id = file.read().strip()


def LogVideoToJSON(video_array):
    with open("downloaded_videos.json", "r") as file:
        data = json.load(file)

    if "authors" not in data:
        data["authors"] = {}

    for video in video_array:
        if isinstance(video, dict):
            authorId = video["authorId"]

            if authorId not in data["authors"]:
                data["authors"][authorId] = {
                    "author": video["author"],
                    "oldUsernames": [],
                    "videoCount":0,
                    "videos": []
                }

            elif data["authors"][authorId]["author"] != video["author"]:
                if video["author"] not in data["authors"][authorId]["oldUsernames"]:
                    data["authors"][authorId]["oldUsernames"].append(data["authors"][authorId]["author"])

                data["authors"][authorId]["author"] = video["author"]

            new_video = {
                "id": video["id"],
                "uploadDate": int(video["createTime"]),
                "musicId": video["music"]["id"],
                "deleted": False,
                "deletedDate": ""
            }

            data["authors"][authorId]["videos"].append(new_video)
            data["authors"][authorId]["videoCount"] = len(data["authors"][authorId]["videos"])
        
    with open("downloaded_videos.json", "w") as file:
        json.dump(data, file, indent=4)



async def GetVideosFromSound():
    with open('current_videos.txt', 'w') as file:
        pass
    async with TikTokApi() as api:
        print('[START]')
        print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Creating API session. Please wait...\n")
        await api.create_sessions(ms_tokens=[ms_token], num_sessions=1, sleep_after=3)
        video_id_array = []
        print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Fetching videos from sound {sound_id}...\n")
        async for video in api.sound(id=sound_id).videos(count=3000):
            video_id_array.append(video.id)
            with open('current_videos.txt', 'a') as file:
                file.write(video.id + '\n')
    return video_id_array


async def GetVideosInfo(new_videos):
    video_array = []
    counter = 0
    total_videos = len(new_videos)
    async with TikTokApi() as api:
        await api.create_sessions(ms_tokens=[ms_token], num_sessions=1, sleep_after=3)
        for video_id in new_videos:
            counter += 1
            video_url = f"https://www.tiktok.com/@user/video/{video_id}"
            video = api.video(url=video_url)
            try:
                video_info = await video.info()
                video_array.append(video_info)
                print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Processed {counter} of {total_videos}")
            except:
                print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Error with video {video_url}")
    print(f"\n[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Successfully fetched {len(video_array)} out of {len(new_videos)} videos.\n")
    return video_array


def GetVideoIDs(videos):
    ids = []
    for video in videos:
        ids.append(video["id"])
    return ids


def GetDownloadedVideos():
    with open ("downloaded_videos.json", "r") as file:
        data = json.load(file)
    videos = []
    for _, author_info in data["authors"].items():
        for video in author_info["videos"]:
            videos.append(video)
    return videos


def GetAuthorFromVideoID(video_id):
    with open ("downloaded_videos.json", "r") as file:
        data= json.load(file)
    for authorId, author_info in data["authors"].items():
        for video in author_info["videos"]:
            if video_id == video["id"]:
                return authorId
    return False


def GetDeletedVideos():
    with open ("downloaded_videos.json", "r") as file:
        data = json.load(file)
    videos = []
    for _, author_info in data["authors"].items():
        for video in author_info["videos"]:
            if video["deleted"] == True:
                videos.append(video)
    return videos


def GetActiveVideos():
    with open ("downloaded_videos.json", "r") as file:
        data = json.load(file)
    videos = []
    for _, author_info in data["authors"].items():
        for video in author_info["videos"]:
            if video["deleted"] == False and video["musicId"] == sound_id:
                videos.append(video)
    return videos


def CheckUndeletedVideos():
    timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    undeleted_videos = []
    with open('current_videos.txt', 'r') as file:
        last_pull = file.read().splitlines()
    with open ("downloaded_videos.json", "r") as file:
        data = json.load(file)

    for video_id in last_pull:
        if video_id in GetVideoIDs(GetDeletedVideos()):
            undeleted_videos.append(video_id)

    if len(undeleted_videos) > 0:
        videos = asyncio.run(GetVideosInfo(undeleted_videos))
        if len(undeleted_videos) == 1:
            video_plural = "video"
        else:
            video_plural = "videos"
        for video_id in undeleted_videos:
            for authorId, author_info in data["authors"].items():
                for video in author_info["videos"]:
                    if video["id"] == video_id:
                        data["authors"][authorId]["videos"].remove(video)
                        with open ("downloaded_videos.json", "w") as file:
                            json.dump(data, file, indent=4)
                        print(f"\n[{timestamp}] Video {video['id']} by @{data['authors'][authorId]['author']} has been marked as undeleted.")
        LogVideoToJSON(videos)
        return f"\n[{timestamp}] Marked {len(undeleted_videos)} {video_plural} as undeleted."
    else:
        return f"\n[{timestamp}] No new undeleted videos found.\n"


def CheckDeletedVideos(ratelimit):
    timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')

    if ratelimit:
        return f"[{timestamp}] No deleted videos found.\n"
    
    counter = 0
    deleted_video_ids = []

    with open('current_videos.txt', 'r') as file:
        last_pull = file.read().splitlines()

    with open ("downloaded_videos.json", "r") as file:
        data = json.load(file)
    
    active_video_ids = GetVideoIDs(GetActiveVideos())

    for video_id in active_video_ids:
        if video_id not in last_pull:
            deleted_video_ids.append(video_id)
            counter += 1
    
    for video_id in deleted_video_ids:
        authorId = GetAuthorFromVideoID(video_id)
        for video in data["authors"][authorId]["videos"]:
            if video["id"] == video_id:
                video["deleted"] = True
                video["deletedDate"] = int(time.time())
                with open ("downloaded_videos.json", "w") as file:
                    json.dump(data, file, indent=4)
                print(f"\n[{timestamp}] Video {video['id']} by @{data['authors'][authorId]['author']} has been deleted.")
    if counter != 0:
        if counter == 1:
            video_plural = "video"
        else:
            video_plural = "videos"
        return f"\n[{timestamp}] Marked {counter} {video_plural} as deleted."
    else:
        return f"\n[{timestamp}] No new deleted videos found.\n"


def DownloadVideo(author_folder, video_id, authorName):
    video_url = f"https://www.tiktok.com/@user/video/{video_id}"
    
    download_services = [mdown, tikdown, snaptik]
    max_retries = 3
    timeout_seconds = 30
    
    for attempt in range(max_retries):
        for download_service in download_services:
            try:
                print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Downloading video {video_id} from @{authorName} using {download_service.__name__}...")
                video_data = time_limited_request(video_url, download_service, timeout_seconds)
                try:
                    video_data[0].download(os.path.join(author_folder, f"{video_id}.mp4"))
                except:
                    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Index error")
                    return
                print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Download successful!\n")
                return
            except (RequestException, TimeoutError) as e:
                print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Failed using {download_service.__name__}: {str(e)}")
                print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Trying next service...")
        
        if attempt < max_retries - 1:
            sleep_time = 2 ** attempt
            print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] All services failed. Retrying all services in {sleep_time} seconds...")
            time.sleep(sleep_time)
    
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Failed to download after several attempts with all services.")
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
        last_txt = file.read().splitlines()

    numberToAverage = 10

    try:
        average = 0
        for value in last_txt[-numberToAverage:]:
            average += int(value)
        average = average/numberToAverage
        last_txt_average = average
        try:
            last_txt_average = int(last_txt[-1])
        except:
            print("Error: last.txt is empty")
            return False
    except:
        print("Error: last.txt is empty")
        return False

    if video_count < (last_txt_average * 0.95):
        return True
    else:
        return False

def ExecuteDeleteCheck(ratelimit):
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Processing deleted videos...\n")
    deleted_status = CheckDeletedVideos(ratelimit)
    print(deleted_status)
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Processing undeleted videos...\n")
    undeleted_status = CheckUndeletedVideos()
    print(undeleted_status)


def Main():
    video_ids = asyncio.run(GetVideosFromSound())
    ratelimit = EvaluateRatelimit(len(video_ids))
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Total videos fetched: {len(video_ids)}")
    if not ratelimit:
        with open('last.txt', 'a') as file:
            file.write('\n' + str(len(video_ids)))
    new_videos = []
    for video_id in video_ids:
        if video_id not in GetVideoIDs(GetDownloadedVideos()):
            new_videos.append(video_id)
    if len(new_videos) == 0:
        print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] No new videos found.")
        ExecuteDeleteCheck(ratelimit)
        return ratelimit
    else:
        print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] New videos found: {len(new_videos)}")
    successfully_downloaded = []
    videos = asyncio.run(GetVideosInfo(new_videos))
    for video in videos:
        authorName = video['author']
        video_id = video['id']
        author_folder = os.path.join('../../Videos/TikTok', f"@{authorName}")
        os.makedirs(author_folder, exist_ok=True)
        DownloadVideo(author_folder, video_id, authorName)
        successfully_downloaded.append(video)
    LogVideoToJSON(successfully_downloaded)
    ExecuteDeleteCheck(ratelimit)
    return ratelimit

print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Starting program...\n")

while True:
    status = Main()
    now = datetime.now()
    nextCycle = datetime.combine(datetime.now().date(), GetNextCycle(now.hour, now.minute))    
    if status:
        nextCycle += timedelta(minutes=60)
        print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Ratelimit likely. Sleeping until {nextCycle.strftime('%H:%M')}...")
    else:
        nextCycle += timedelta(minutes=15)
        print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Sleeping until {nextCycle.strftime('%H:%M')}...")
    print('[END]')
    if nextCycle < now:
        nextCycle += timedelta(days=1)
    difference = (nextCycle - now).total_seconds()
    time.sleep(difference)
    print('\n\n')