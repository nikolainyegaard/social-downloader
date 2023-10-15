from tikapi import TikAPI, ValidationException, ResponseException
import json

api = TikAPI("bMIMXdol1icOWY7O53zZQ1MM8rSVK3NzU1KO1QfOEpwF539W")

try:
    response = api.public.video(id="7193668162418740486")

    with open('video_info.json', 'w') as f:
        json.dump(response.json(), f)

except ValidationException as e:
    print(e, e.field)

except ResponseException as e:
    print(e, e.response.status_code)
