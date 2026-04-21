print("START")

import sounddevice as sd

print("AFTER IMPORT")

devices = sd.query_devices()

print("Devices found:", len(devices))

for i, device in enumerate(devices):
    print(f"{i}: {device}")

print("END")