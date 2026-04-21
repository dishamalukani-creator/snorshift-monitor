import os
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3'
os.environ['TF_ENABLE_ONEDNN_OPTS'] = '0'
import csv, tensorflow_hub as hub

model = hub.load('https://tfhub.dev/google/yamnet/1')
names = []
with open(model.class_map_path().numpy().decode('utf-8'), newline='', encoding='utf-8') as f:
    for row in csv.DictReader(f):
        names.append(row.get('display_name','').strip())

print('Index 30-50:')
for i in range(30, 50):
    print(f'  [{i}] {names[i]}')

print('\nAll breath/snore/wheeze related:')
for i, n in enumerate(names):
    if any(k in n.lower() for k in ['snor','breath','wheez','gasp','respir','stertor','cough','throat']):
        print(f'  [{i}] {n}')
