import os
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3'
os.environ['TF_ENABLE_ONEDNN_OPTS'] = '0'

import csv
import numpy as np
import sounddevice as sd
import tensorflow_hub as hub

print('Loading YAMNet...')
model = hub.load('https://tfhub.dev/google/yamnet/1')

class_csv = model.class_map_path().numpy().decode('utf-8')
names = []
with open(class_csv, newline='', encoding='utf-8') as f:
    for row in csv.DictReader(f):
        names.append(row.get('display_name', '').strip().lower())

print(f'Classes loaded: {len(names)}')

snore_kw   = {'snoring','snore','breathing','heavy breathing','stertor','respiratory sounds','breath'}
gasp_kw    = {'wheeze','wheezing','cough','coughing','throat clearing','choking','gasp','gasping','stridor'}
speech_kw  = {'speech','talking','speaking','conversation','narration','monologue','male speech','female speech','child speech','babbling','whispering','shout','yell','singing'}

snore_idx  = {i for i,n in enumerate(names) if any(k in n for k in snore_kw)}
gasp_idx   = {i for i,n in enumerate(names) if any(k in n for k in gasp_kw)}
speech_idx = {i for i,n in enumerate(names) if any(k in n for k in speech_kw)}

print(f'Snore indices:  {sorted(snore_idx)}')
print(f'Gasp indices:   {sorted(gasp_idx)}')
print(f'Speech indices: {sorted(speech_idx)}')
print()

print('=== Recording 3s — Make snoring sound NOW ===')
audio = sd.rec(16000*3, samplerate=16000, channels=1, dtype='float32', device=1)
sd.wait()
waveform = audio.flatten()

energy = float(np.mean(waveform**2))
print(f'Energy:     {energy:.8f}  (SILENCE threshold: 0.000003)')
print(f'Max amp:    {np.max(np.abs(waveform)):.6f}')

max_val = np.max(np.abs(waveform))
if max_val > 1e-6:
    waveform_n = waveform / max_val
else:
    waveform_n = waveform

scores, _, _ = model(waveform_n)
mean_scores = np.mean(scores.numpy(), axis=0)

top10 = np.argsort(mean_scores)[::-1][:10]
print('\nTop 10 detected classes:')
for i in top10:
    print(f'  [{i:3d}] {names[i]:<40} {mean_scores[i]:.4f}')

snore_score  = max((float(mean_scores[i]) for i in snore_idx  if i < len(mean_scores)), default=0)
gasp_score   = max((float(mean_scores[i]) for i in gasp_idx   if i < len(mean_scores)), default=0)
speech_score = max((float(mean_scores[i]) for i in speech_idx if i < len(mean_scores)), default=0)

print(f'\nSnore score:  {snore_score:.4f}  (need >= 0.10 to detect)')
print(f'Gasp score:   {gasp_score:.4f}  (need >= 0.15 to detect)')
print(f'Speech score: {speech_score:.4f}  (need >= 0.35 to suppress)')

print('\n--- DIAGNOSIS ---')
if energy < 0.000003:
    print('PROBLEM: Energy too low — mic not picking up sound (energy gate blocking)')
elif snore_score < 0.10:
    print(f'PROBLEM: Snore score {snore_score:.4f} is below threshold 0.10')
    print('  -> Either sound is not snore-like, or threshold needs lowering')
elif speech_score >= 0.35:
    print(f'PROBLEM: Speech score {speech_score:.4f} is suppressing snore detection')
else:
    print('OK: Should be detecting snoring!')
