from tikapi import TikAPI, ValidationException, ResponseException
import json

api = TikAPI("7dwWrHNFgSobFJ0UTfCMo5Tw1WyyiqEQjrv4YUCj0MHQF7Ka")

try:
    response = response = api.public.music(id="7192626048159288106")

    with open('music_info.json', 'w') as f:
        json.dump(response.json(), f)

except ValidationException as e:
    print(e, e.field)

except ResponseException as e:
    print(e, e.response.status_code)
