from datetime import datetime

now = datetime.now()

hours = now.hour
minutes = now.minute

def getTime(hours, minutes):
    if minutes == 45:
        return datetime.strptime(f"{hours+1}:{00}", "%H:%M").time()
    elif minutes % 15 == 0:
        return datetime.strptime(f"{hours}:{minutes+15}", "%H:%M").time()
    else:
        if minutes // 15 == 0:
            return datetime.strptime(f"{hours}:{30}", "%H:%M").time()
        elif minutes // 15 == 1:
            return datetime.strptime(f"{hours}:{45}", "%H:%M").time()
        elif minutes // 15 == 2:
            return datetime.strptime(f"{hours+1}:{00}", "%H:%M").time()
        elif minutes // 15 == 3:
            return datetime.strptime(f"{hours+1}:{15}", "%H:%M").time()

# target = getTime(hours, minutes)
# print(target.strftime("%H:%M"))

# difference = (datetime.combine(datetime.now().date(), target) - datetime.combine(datetime.now().date(), now.time())).total_seconds()

nextCycle = datetime.combine(datetime.now().date(), getTime(now.hour, now.minute))
difference = (nextCycle - now).total_seconds()

print(nextCycle.strftime("%H:%M"))