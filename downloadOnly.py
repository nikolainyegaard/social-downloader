from TikTokApi import TikTokApi
import asyncio
import os
import time
import json
from requests.exceptions import RequestException
from tiktok_downloader import snaptik, mdown, tikdown
from datetime import datetime

input_link = input("Link: ")

ms_token = os.environ.get("ms_token", None)

video_id = input_link.split("/")[5].split("?")[0]
authorName = input_link.split("/")[3].strip("@")
author_folder = os.path.join('../../Videos/TikTok', f"@{authorName}/Extra")


def GetDeletedVideos():
    with open ("downloaded_videos.json", "r") as file:
        data = json.load(file)
    videos = []
    for _, author_info in data["authors"].items():
        for video in author_info["videos"]:
            if video["deleted"] == True:
                videos.append(video)
    return videos


async def GetVideosInfo(new_videos):
    deleted = GetVideoIDs(GetDeletedVideos())
    video_array = []
    new_videos_clean = []
    counter = 0
    for video_id in new_videos:
        if video_id not in deleted:
            new_videos_clean.append(video_id)
        else:
            video_array.append(video_id)
    total_videos = len(new_videos_clean)
    async with TikTokApi() as api:
        await api.create_sessions(ms_tokens=[ms_token], num_sessions=1, sleep_after=3)
        for video_id in new_videos_clean:
            counter += 1
            video_url = f"https://www.tiktok.com/@user/video/{video_id}"
            video = api.video(url=video_url)
            try:
                video_info = await video.info()
                video_array.append(video_info)
                print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Processed {counter} of {total_videos}")
            except:
                video_array.append(video_id)
                print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Error with video {video_url}")
    print(f"\n[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Successfully fetched {len(video_array)} out of {len(new_videos)} videos.\n")
    return video_array


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
        elif isinstance(video, str):
            authorId = "0000000000000000000"

            if authorId not in data["authors"]:
                data["authors"][authorId] = {
                    "author": "unknown",
                    "oldUsernames": "unknown",
                    "videoCount":0,
                    "videos": []
                }
            
            new_video = {
                "id": video,
                "uploadDate": "unknown",
                "musicId": "unknown",
                "deleted": True,
                "deletedDate": int(time.time())
            }
            data["authors"][authorId]["videos"].append(new_video)
            data["authors"][authorId]["videoCount"] = len(data["authors"][authorId]["videos"])

    with open("downloaded_videos.json", "w") as file:
        json.dump(data, file, indent=4)


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


def main(video_id):
    if video_id not in GetVideoIDs(GetDownloadedVideos()):
        successfully_downloaded = []
        videos = asyncio.run(GetVideosInfo([video_id]))
        for video in videos:
            try:
                authorName = video['author']
            except:
                print(f"The following variable is not a valid video object.")
                print(video)
            video_id = video['id']
            author_folder = os.path.join('../../Videos/TikTok', f"@{authorName}")
            os.makedirs(author_folder, exist_ok=True)
            DownloadVideo(author_folder, video_id, authorName)
            successfully_downloaded.append(video)
        LogVideoToJSON(successfully_downloaded)
    else:
        print(f"Video with ID {video_id} has been downloaded already. Exiting program.")

main(video_id)