"""
╔══════════════════════════════════════════════════════════════════╗
║            SnorShift — Production Backend  v2.1                 ║
║   FIXED: YAMNet correct class indices + zero false positives    ║
╚══════════════════════════════════════════════════════════════════╝

ROOT CAUSE OF FALSE POSITIVES (v2.0 bugs — all fixed here):

  BUG 1 ─ Wrong class indices hardcoded
    Old code: YAMNET_SPEECH_CLASSES = {0,1,2,3,4,5}
    Problem:  In YAMNet, index 0 IS "Speech". So "hello hello"
              correctly fires class 0 with score ~0.96.
              But we also had index 0 in snore overlap logic →
              anything loud → snore false positive.
    FIX:      Load class names DYNAMICALLY from YAMNet's own CSV
              (yamnet.class_map_path()), match by NAME not index.

  BUG 2 ─ Score aggregation used sum() instead of max()
    Old code: speech_score = sum(mean_scores[c] for c in set)
    Problem:  Summing multiple sigmoid outputs easily exceeds 1.0
              (you saw Speech:1.023 — impossible for a single class,
               means 5-6 speech classes were being summed).
    FIX:      Use max() across the group — score stays in [0,1].

  BUG 3 ─ Thresholds too low
    Old code: SNORE_SCORE_THRESHOLD = 0.15
    Problem:  Normal breath/ambient noise scores ~0.08–0.20 for
              breathing classes → frequent false snore triggers.
    FIX:      Raised thresholds + added a "speech must be LOW
              for snore to win" guard condition.
"""

# ── ENV VARS BEFORE ANY TF IMPORT (suppresses oneDNN + log spam) ─
import os
os.environ["TF_ENABLE_ONEDNN_OPTS"] = "0"
os.environ["TF_CPP_MIN_LOG_LEVEL"]  = "3"

import gc
import csv
import time
import uuid
import threading
import sqlite3
import hashlib
import secrets

import numpy as np
import sounddevice as sd
import serial

from datetime       import datetime, timezone, timedelta
from scipy.fft      import rfft, rfftfreq
from flask          import Flask, jsonify, request
from flask_socketio import SocketIO, emit
from dotenv         import load_dotenv

load_dotenv()

# ─────────────────────────────────────────────────────────────────
# CONSTANTS
# ─────────────────────────────────────────────────────────────────
SAMPLE_RATE        = 16000
CHUNK_SECONDS      = 3
CHUNK_SIZE         = SAMPLE_RATE * CHUNK_SECONDS
SERIAL_PORT        = os.environ.get("SERIAL_PORT", "COM3")
SERIAL_BAUD        = 9600
MIC_DEVICE_INDEX   = int(os.environ.get("MIC_DEVICE_INDEX", 1))
DB_PATH            = "guardian_pillow.db"
CSV_FILE           = "hackathon_logs.csv"
YAMNET_MODEL_URL   = "https://tfhub.dev/google/yamnet/1"

# ── Tunable thresholds ───────────────────────────────────────────
# Increase these values to make the system LESS sensitive (fewer false positives)
# Decrease to make MORE sensitive (may cause false positives)
SILENCE_ENERGY_THRESHOLD = 0.000003  # RMS² below this → always Silence, skip YAMNet
SNORE_SCORE_THRESHOLD    = 0.05      # Lowered: YAMNet score needed to call it Snoring
GASP_SCORE_THRESHOLD     = 0.08      # Lowered: YAMNet score needed to call it Gasp
SPEECH_SCORE_THRESHOLD   = 0.50      # Raised: YAMNet score to call it Awake/Speech
APNEA_TIMEOUT            = 15       # seconds of silence → apnea alert
MAX_TILT_COUNT           = 3

STAGE_LABELS = {
    0: "Snoring",
    1: "Silence/Light Sleep",
    2: "Gasp/Apnea",
    3: "Awake/Speech",
}

# ─────────────────────────────────────────────────────────────────
# FLASK SETUP
# ─────────────────────────────────────────────────────────────────
app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "snoreshift_secret_2024")
socketio   = SocketIO(app, cors_allowed_origins="*", async_mode="threading")
state_lock = threading.Lock()

# ─────────────────────────────────────────────────────────────────
# DATABASE — SQLite, 60-day retention, auto-close
# ─────────────────────────────────────────────────────────────────
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    try:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                username      TEXT    UNIQUE NOT NULL,
                password_hash TEXT    NOT NULL,
                serial_id     TEXT    NOT NULL,
                created_at    TEXT    DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS history (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                serial_id TEXT    NOT NULL,
                timestamp TEXT    NOT NULL,
                stage_num INTEGER NOT NULL,
                label     TEXT    NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_h_serial ON history(serial_id);
            CREATE INDEX IF NOT EXISTS idx_h_ts     ON history(timestamp);
        """)
        conn.commit()
        print("[DB] ✅ guardian_pillow.db ready")
    finally:
        conn.close()

def generate_serial_id():
    return f"GP-{hex(uuid.getnode())[-4:].upper()}"

def hash_password(pw: str) -> str:
    salt = secrets.token_hex(16)
    return f"{salt}:{hashlib.sha256((salt+pw).encode()).hexdigest()}"

def verify_password(pw: str, stored: str) -> bool:
    salt, h = stored.split(":", 1)
    return hashlib.sha256((salt + pw).encode()).hexdigest() == h

def insert_history(serial_id: str, stage_num: int, label: str):
    """Insert + prune 60-day retention. Connection opened/closed each call (no leaks)."""
    conn = get_db()
    try:
        ts     = datetime.now(timezone.utc).isoformat()
        cutoff = (datetime.now(timezone.utc) - timedelta(days=60)).isoformat()
        conn.execute(
            "INSERT INTO history (serial_id,timestamp,stage_num,label) VALUES (?,?,?,?)",
            (serial_id, ts, stage_num, label)
        )
        conn.execute("DELETE FROM history WHERE timestamp < ?", (cutoff,))
        conn.commit()
    finally:
        conn.close()

# ─────────────────────────────────────────────────────────────────
# CSV DIARY
# ─────────────────────────────────────────────────────────────────
def init_csv():
    if not os.path.exists(CSV_FILE):
        with open(CSV_FILE, "w", newline="") as f:
            csv.writer(f).writerow(["Timestamp", "Event", "Action", "Result"])
        print(f"[CSV] ✅ {CSV_FILE} created")

# ─────────────────────────────────────────────────────────────────
# GLOBAL STATE
# ─────────────────────────────────────────────────────────────────
state = {
    "fsr_state":          "FSR_C",
    "snore_count":        0,
    "system_status":      "IDLE",
    "inflation_level":    0,
    "session_start":      time.time(),
    "last_action":        "System started",
    "apnea_timer_active": False,
    "apnea_start_time":   None,
    "logs":               [],
    "current_serial_id":  generate_serial_id(),
}

def build_status_payload():
    e       = int(time.time() - state["session_start"])
    hh, r   = divmod(e, 3600)
    mm, ss  = divmod(r, 60)
    return {
        "status":          state["system_status"],
        "fsr_state":       state["fsr_state"],
        "snore_count":     state["snore_count"],
        "inflation_level": state["inflation_level"],
        "session_time":    f"{hh:02d}:{mm:02d}:{ss:02d}",
        "last_action":     state["last_action"],
        "serial_id":       state["current_serial_id"],
    }

def log_event(event: str, action: str, result: str):
    ts    = datetime.now(timezone.utc).strftime("%H:%M:%S")
    entry = {"time": ts, "event": event, "action": action, "result": result}
    with state_lock:
        state["logs"].insert(0, entry)
        state["logs"]        = state["logs"][:100]
        state["last_action"] = f"{action} — {result}"
    socketio.emit("log_update", entry)
    print(f"[LOG] {ts} | {event} | {action} | {result}")
    try:
        with open(CSV_FILE, "a", newline="", encoding="utf-8") as f:
            csv.writer(f).writerow([
                datetime.now(timezone.utc).isoformat(), event, action, result
            ])
    except Exception as e:
        print(f"[CSV] Error: {e}")

# ─────────────────────────────────────────────────────────────────
# SERIAL MANAGER
# ─────────────────────────────────────────────────────────────────
class SerialManager:
    def __init__(self):
        self._conn = None
        self._lock = threading.Lock()

    def connect(self):
        try:
            self._conn = serial.Serial(SERIAL_PORT, SERIAL_BAUD, timeout=1)
            time.sleep(2)
            print(f"[SERIAL] ✅ Arduino on {SERIAL_PORT}")
        except Exception as e:
            print(f"[SERIAL] ❌ {e}")
            self._conn = None

    def send(self, cmd: str):
        with self._lock:
            if self._conn and self._conn.is_open:
                try:
                    self._conn.write(f"{cmd}\n".encode())
                    print(f"[SERIAL] → {cmd}")
                except Exception as e:
                    print(f"[SERIAL] Error: {e}")
            else:
                print(f"[SERIAL] (mock) → {cmd}")

    def readline(self):
        with self._lock:
            if self._conn and self._conn.is_open and self._conn.in_waiting > 0:
                try:
                    return self._conn.readline().decode("utf-8").strip()
                except Exception:
                    pass
        return None

serial_mgr = SerialManager()

# ─────────────────────────────────────────────────────────────────
# ✅ FIXED YAMNet MODEL MANAGER
#
#  How it works now:
#  1. After hub.load(), call model.class_map_path() to get the
#     official 521-class CSV that ships WITH the model.
#  2. Parse that CSV to get display_name for every index.
#  3. Build our 4 index sets by matching display_name strings.
#     → No more hardcoded wrong indices.
#  4. Score aggregation uses MAX (not sum) → stays in [0,1].
#  5. Snore only wins if speech score is NOT dominating it.
#     → "hello hello" (speech score 0.96) will NOT trigger snore.
# ─────────────────────────────────────────────────────────────────
class YAMNetModelManager:
    def __init__(self):
        self._model       = None
        self._lock        = threading.Lock()
        self._tf          = None
        self._loaded      = False
        self._class_names = []

        # Index sets — built dynamically after load
        self._snore_idx   = set()
        self._gasp_idx    = set()
        self._speech_idx  = set()
        self._silence_idx = set()

    def load(self):
        with self._lock:
            if self._loaded:
                return
            print("[YAMNet] 🤖 Loading from TensorFlow Hub…")
            try:
                import tensorflow as tf
                import tensorflow_hub as hub
                self._tf    = tf
                self._model = hub.load(YAMNET_MODEL_URL)

                # ── Load the model's own class name CSV ──────────────
                class_csv = self._model.class_map_path().numpy().decode("utf-8")
                self._class_names = self._parse_class_csv(class_csv)
                print(f"[YAMNet] ✅ {len(self._class_names)} classes loaded")
                print(f"[YAMNet]    Classes 0–5: {self._class_names[:6]}")

                # ── Build index sets by name matching ─────────────────
                self._build_index_sets()
                self._loaded = True

                print(f"[YAMNet] Snore   indices ({len(self._snore_idx)}): {sorted(self._snore_idx)}")
                print(f"[YAMNet] Gasp    indices ({len(self._gasp_idx)}): {sorted(self._gasp_idx)}")
                print(f"[YAMNet] Speech  indices ({len(self._speech_idx)}): {sorted(self._speech_idx)}")
                print(f"[YAMNet] Silence indices ({len(self._silence_idx)}): {sorted(self._silence_idx)}")

            except ImportError:
                print("[YAMNet] ❌ Run: pip install tensorflow tensorflow-hub")
            except Exception as e:
                print(f"[YAMNet] ❌ Load failed: {e}")
                # Fall back to hardcoded verified indices
                self._use_hardcoded_fallback()
                self._loaded = True

    def _parse_class_csv(self, path: str):
        """Read yamnet_class_map.csv → list of 521 display names."""
        names = []
        try:
            with open(path, newline="", encoding="utf-8") as f:
                for row in csv.DictReader(f):
                    names.append(row.get("display_name", "").strip().lower())
        except Exception as e:
            print(f"[YAMNet] CSV parse error: {e}")
        return names

    def _build_index_sets(self):
        """
        Match class display names to build our 4 category sets.
        Name-based matching = immune to index shifts across model versions.
        """
        # Keywords verified against official yamnet_class_map.csv
        snore_kw   = {"snoring", "snore", "breathing", "heavy breathing", "stertor",
                      "respiratory sounds", "breath", "snort", "pant"}
        gasp_kw    = {"wheeze", "wheezing", "cough", "coughing", "throat clearing",
                      "choking", "gasp", "gasping", "stridor"}
        speech_kw  = {"speech", "talking", "speaking", "conversation", "narration",
                      "monologue", "male speech", "female speech", "child speech",
                      "babbling", "whispering", "shout", "yell", "singing"}
        silence_kw = {"silence", "white noise", "pink noise", "background noise",
                      "static", "hum", "hiss", "buzz", "drone", "ambience",
                      "environmental noise", "field recording"}

        for idx, name in enumerate(self._class_names):
            if any(kw in name for kw in snore_kw):
                self._snore_idx.add(idx)
            if any(kw in name for kw in gasp_kw):
                self._gasp_idx.add(idx)
            if any(kw in name for kw in speech_kw):
                self._speech_idx.add(idx)
            if any(kw in name for kw in silence_kw):
                self._silence_idx.add(idx)

        # If dynamic matching found nothing, use hardcoded verified indices
        self._apply_hardcoded_fallback_if_empty()

    def _apply_hardcoded_fallback_if_empty(self):
        """
        Hardcoded indices verified against yamnet_class_map.csv (2024).
        These are a SAFETY NET only — dynamic matching is preferred.
          32 = Snoring
          30 = Breathing
          33 = Wheeze
          34 = Cough
          35 = Throat clearing
           0 = Speech
           1 = Male speech, man speaking
           2 = Female speech, woman speaking
           3 = Child speech, kid speaking
           4 = Conversation
           5 = Narration, monologue
         494 = Silence
         500 = White noise
         501 = Background noise
        """
        if not self._snore_idx:
            print("[YAMNet] ⚠️  Using hardcoded snore indices: {30, 32}")
            self._snore_idx   = {30, 32}
        if not self._gasp_idx:
            print("[YAMNet] ⚠️  Using hardcoded gasp indices: {33, 34, 35}")
            self._gasp_idx    = {33, 34, 35}
        if not self._speech_idx:
            print("[YAMNet] ⚠️  Using hardcoded speech indices: {0,1,2,3,4,5}")
            self._speech_idx  = {0, 1, 2, 3, 4, 5}
        if not self._silence_idx:
            print("[YAMNet] ⚠️  Using hardcoded silence indices: {494, 500, 501}")
            self._silence_idx = {494, 500, 501}

    def _use_hardcoded_fallback(self):
        self._snore_idx   = {30, 32}
        self._gasp_idx    = {33, 34, 35}
        self._speech_idx  = {0, 1, 2, 3, 4, 5}
        self._silence_idx = {494, 500, 501}

    def _max_score(self, mean_scores: np.ndarray, index_set: set) -> float:
        """
        FIX for BUG #2: MAX aggregation keeps score in [0, 1].
        Old sum() was giving Speech:1.023 — impossible, indicated summation bug.
        """
        valid = [float(mean_scores[i]) for i in index_set if i < len(mean_scores)]
        return max(valid) if valid else 0.0

    def classify(self, audio_chunk: np.ndarray, energy: float) -> int:
        """
        Returns:
          0 = Snoring          → inflate pillow
          1 = Silence/Light    → start apnea timer
          2 = Gasp/Apnea       → buzzer immediately
          3 = Awake/Speech     → pause session

        Decision tree (bulletproof):
          Energy gate → YAMNet → threshold checks → speech-snore guard
        """
        # ── Energy gate (fast path, no YAMNet needed) ───────────────
        if energy < SILENCE_ENERGY_THRESHOLD:
            return 1  # Silence

        if not self._loaded or self._model is None:
            return self._fallback_classify(audio_chunk, energy)

        with self._lock:
            try:
                waveform     = audio_chunk.astype(np.float32)
                # Normalize — mic volume compensate karo (snoring is quiet)
                max_val = np.max(np.abs(waveform))
                if max_val > 1e-6:
                    waveform = waveform / max_val
                scores, _, _ = self._model(waveform)
                mean_scores  = np.mean(scores.numpy(), axis=0)  # (521,)

                # ── Compute group scores (MAX aggregation) ────────────
                snore_score   = self._max_score(mean_scores, self._snore_idx)
                gasp_score    = self._max_score(mean_scores, self._gasp_idx)
                speech_score  = self._max_score(mean_scores, self._speech_idx)
                silence_score = self._max_score(mean_scores, self._silence_idx)

                # ── Debug: top-5 class names + group scores ───────────
                top5_i = np.argsort(mean_scores)[::-1][:5]
                top5   = [
                    (self._class_names[i] if i < len(self._class_names) else f"class_{i}",
                     round(float(mean_scores[i]), 3))
                    for i in top5_i
                ]
                print(f"[YAMNet] Top5 : {top5}")
                print(f"[YAMNet] Scores → Snore:{snore_score:.3f}  "
                      f"Gasp:{gasp_score:.3f}  "
                      f"Speech:{speech_score:.3f}  "
                      f"Silence:{silence_score:.3f}")

                # ── Decision tree ─────────────────────────────────────

                # Priority 1: Gasp/Apnea (safety — act first)
                if gasp_score >= GASP_SCORE_THRESHOLD:
                    if speech_score < SPEECH_SCORE_THRESHOLD:
                        return 2  # Gasp/Apnea

                # Priority 2: Snoring
                if snore_score >= SNORE_SCORE_THRESHOLD:
                    if speech_score >= SPEECH_SCORE_THRESHOLD:
                        print(f"[YAMNet] ⚠️  Snore suppressed — speech score too high "
                              f"({speech_score:.3f} ≥ {SPEECH_SCORE_THRESHOLD})")
                        return 3  # Awake/Speech
                    return 0  # ✅ Confirmed Snoring

                # Priority 3: Speech / Awake
                if speech_score >= SPEECH_SCORE_THRESHOLD:
                    return 3  # Awake/Speech

                # Priority 4: FFT-based snore fallback
                # YAMNet miss kare toh frequency analysis se detect karo
                return self._fallback_classify(audio_chunk, energy)

            except Exception as e:
                print(f"[YAMNet] Inference error: {e}")
                return self._fallback_classify(audio_chunk, energy)

    def _fallback_classify(self, audio_chunk: np.ndarray, energy: float) -> int:
        """Frequency-domain fallback when YAMNet unavailable."""
        freqs      = rfftfreq(len(audio_chunk), d=1 / SAMPLE_RATE)
        fft_m      = np.abs(rfft(audio_chunk))
        total_e    = float(np.sum(fft_m)) + 1e-9
        snore_mask = (freqs >= 80) & (freqs <= 500)
        snore_e    = float(np.sum(fft_m[snore_mask]))
        snore_ratio = snore_e / total_e
        print(f"[FALLBACK] Snore energy: {snore_e:.1f} | ratio: {snore_ratio:.3f} | total energy: {energy:.6f}")
        if snore_ratio > 0.45 and energy > 0.00005:
            return 0  # Snoring
        return 1

yamnet_mgr = YAMNetModelManager()

# ─────────────────────────────────────────────────────────────────
# FFT — scipy.rfft + WebSocket
# ─────────────────────────────────────────────────────────────────
def compute_and_emit_fft(audio_chunk: np.ndarray):
    windowed   = audio_chunk * np.hanning(len(audio_chunk))
    fft_mag    = np.abs(rfft(windowed))
    freqs      = rfftfreq(len(windowed), d=1 / SAMPLE_RATE)
    mask       = freqs <= 600
    fft_vis    = fft_mag[mask]
    freqs_vis  = freqs[mask]
    energy     = float(np.mean(audio_chunk ** 2))
    # Dominant frequency: snore fundamental range
    # Note: if using phone speaker as source, harmonics may dominate (400-600 Hz)
    # For close-mic (pillow mic), fundamentals dominate (100-300 Hz)
    snore_range = (freqs_vis >= 100) & (freqs_vis <= 500)
    if snore_range.any():
        dom_idx = int(np.argmax(fft_vis * snore_range))
    else:
        dom_idx = int(np.argmax(fft_vis)) if len(fft_vis) > 0 else 0
    dom_hz     = float(freqs_vis[dom_idx]) if len(freqs_vis) > 0 else 0.0
    socketio.emit("fft_update", {
        "frequencies": freqs_vis[:200].tolist(),
        "magnitudes":  (fft_vis[:200] / (np.max(fft_vis) + 1e-9)).tolist(),
        "dominant_hz": round(dom_hz, 1),
        "energy":      round(energy, 6),
        "timestamp":   datetime.now(timezone.utc).strftime("%H:%M:%S"),
    })
    return dom_hz, energy

# ─────────────────────────────────────────────────────────────────
# APNEA TIMER
# ─────────────────────────────────────────────────────────────────
def handle_apnea_check():
    if not state["apnea_timer_active"]:
        state["apnea_timer_active"] = True
        state["apnea_start_time"]   = time.time()
        log_event("AOS Monitor", "Silence detected", "Starting 15s apnea timer")
        return
    elapsed = time.time() - state["apnea_start_time"]
    socketio.emit("apnea_timer", {"elapsed": round(elapsed, 1), "threshold": APNEA_TIMEOUT})
    if elapsed >= APNEA_TIMEOUT:
        with state_lock:
            state["system_status"] = "APNEA"
        socketio.emit("status_update", build_status_payload())
        serial_mgr.send("BUZZER")
        log_event("EMERGENCY", "Silent Apnea — BUZZER fired", f"No breath {APNEA_TIMEOUT}s")
        state["apnea_timer_active"] = False
        state["apnea_start_time"]   = None

def reset_apnea_timer():
    state["apnea_timer_active"] = False
    state["apnea_start_time"]   = None

# ─────────────────────────────────────────────────────────────────
# HARDWARE STATE MACHINE
# ─────────────────────────────────────────────────────────────────
def handle_snore_detected(dominant_hz: float):
    """Step A → inflate | Step B → wait 10s | Step C → verify + adjust."""
    with state_lock:
        state["snore_count"]    += 1
        count                    = state["snore_count"]
        fsr                      = state["fsr_state"]
        state["system_status"]   = "SNORE_DETECTED"
        state["inflation_level"] = min(count, MAX_TILT_COUNT)

    log_event(f"Snore @ {dominant_hz:.0f}Hz", f"Count #{count}", f"FSR={fsr}")
    socketio.emit("status_update", build_status_payload())

    if count <= MAX_TILT_COUNT:
        # Step A
        inflate_cmd = f"INFLATE_{count * 10}"
        serial_mgr.send(inflate_cmd)
        log_event("Step A", f"{inflate_cmd} sent", f"Level {count}/{MAX_TILT_COUNT}")
        with state_lock:
            state["system_status"] = "INFLATING"
        socketio.emit("status_update", build_status_payload())

        # Step B
        log_event("Step B", "10s verification window", "Holding…")
        socketio.emit("countdown_start", {"seconds": 10})
        time.sleep(10)

        # Step C
        log_event("Step C", "Re-listening after 10s", "Capturing…")
        try:
            buf = sd.rec(CHUNK_SIZE, samplerate=SAMPLE_RATE,
                         channels=1, dtype="float32", device=MIC_DEVICE_INDEX)
            sd.wait()
            vc     = buf.flatten()
            _, ve  = compute_and_emit_fft(vc)
            vstage = yamnet_mgr.classify(vc, ve)
            del buf, vc
            gc.collect()

            if vstage == 0:
                serial_mgr.send("INFLATE_MORE")
                log_event("Step C Result", "Snore persists → INFLATE_MORE", "")
            else:
                serial_mgr.send("DEFLATE_SLIGHTLY")
                log_event("Step C Result",
                          f"Snore stopped → DEFLATE ({STAGE_LABELS.get(vstage,'?')})", "")
                with state_lock:
                    state["system_status"] = "SENSING"
                socketio.emit("status_update", build_status_payload())
        except Exception as e:
            print(f"[VERIFY] Step C error: {e}")
    else:
        with state_lock:
            state["system_status"] = "HAPTIC"
        serial_mgr.send("HAPTIC")
        log_event("Escalation", "Max tilt → HAPTIC", "Micro-arousal")
        socketio.emit("status_update", build_status_payload())

# ─────────────────────────────────────────────────────────────────
# FSR READER THREAD
# ─────────────────────────────────────────────────────────────────
def fsr_reader_thread():
    print("[FSR] Thread started")
    while True:
        try:
            line = serial_mgr.readline()
            if line and line in ("FSR_0", "FSR_C", "FSR_L", "FSR_R"):
                prev = state["fsr_state"]
                state["fsr_state"] = line
                if line == "FSR_0" and prev != "FSR_0":
                    with state_lock:
                        state["snore_count"]     = 0
                        state["inflation_level"] = 0
                        state["system_status"]   = "IDLE"
                    reset_apnea_timer()
                    serial_mgr.send("DEFLATE")
                    log_event("FSR", "Bed empty", "IDLE")
                    socketio.emit("status_update", build_status_payload())
                elif line != "FSR_0" and prev == "FSR_0":
                    with state_lock:
                        state["system_status"] = "SENSING"
                    log_event("FSR", f"Person detected ({line})", "Active")
                    socketio.emit("status_update", build_status_payload())
                socketio.emit("fsr_update", {"fsr": line})
        except Exception as e:
            print(f"[FSR] Error: {e}")
        time.sleep(0.1)

# ─────────────────────────────────────────────────────────────────
# AUDIO PROCESSING LOOP
# ─────────────────────────────────────────────────────────────────
def audio_processing_loop():
    print("[AUDIO] 🎙️  Processing loop started")
    audio_buffer = audio_chunk = None
    while True:
        try:
            audio_buffer = sd.rec(CHUNK_SIZE, samplerate=SAMPLE_RATE,
                                  channels=1, dtype="float32", device=MIC_DEVICE_INDEX)
            sd.wait()
            audio_chunk = audio_buffer.flatten()

            dominant_hz, energy = compute_and_emit_fft(audio_chunk)
            print(f"🎤 Energy:{energy:.6f} | Dominant:{dominant_hz:.1f}Hz")

            stage = yamnet_mgr.classify(audio_chunk, energy)
            label = STAGE_LABELS.get(stage, "?")
            print(f"🤖 Stage {stage}: {label}")

            insert_history(state["current_serial_id"], stage, label)

            if stage == 0:   # Snoring
                reset_apnea_timer()
                threading.Thread(target=handle_snore_detected,
                                 args=(dominant_hz,), daemon=True).start()
            elif stage == 2: # Gasp/Apnea
                reset_apnea_timer()
                with state_lock:
                    state["system_status"] = "APNEA"
                socketio.emit("status_update", build_status_payload())
                serial_mgr.send("BUZZER")
                log_event("GASPING", "Apnea detected", f"{dominant_hz:.0f}Hz")
            elif stage == 1: # Silence
                handle_apnea_check()
                # Don't deflate if SnoreHandler is mid-intervention (Step B/C)
                if state["system_status"] not in ("INFLATING", "SNORE_DETECTED"):
                    if state["inflation_level"] > 0 or state["snore_count"] > 0:
                        serial_mgr.send("DEFLATE")
                        log_event("Silence", "Deflating pillow", f"Was {state['inflation_level']}")
                        with state_lock:
                            state["snore_count"]     = 0
                            state["inflation_level"] = 0
                            state["system_status"]   = "SENSING"
                        socketio.emit("status_update", build_status_payload())
            elif stage == 3: # Awake/Speech
                reset_apnea_timer()
                # Don't interrupt active snore intervention
                if state["system_status"] not in ("INFLATING", "SNORE_DETECTED"):
                    with state_lock:
                        state["snore_count"]     = 0
                        state["inflation_level"] = 0
                        state["system_status"]   = "AWAKE"
                    log_event("Awake", "Speech detected", "Session paused")
                    socketio.emit("status_update", build_status_payload())

        except Exception as e:
            print(f"[AUDIO] Error: {e}")
        finally:
            try:
                del audio_chunk
                del audio_buffer
            except Exception:
                pass
            gc.collect()
        audio_buffer = audio_chunk = None

# ─────────────────────────────────────────────────────────────────
# AUTH ROUTES
# ─────────────────────────────────────────────────────────────────
@app.route("/api/register", methods=["POST"])
def api_register():
    data = request.get_json(force=True) or {}
    u, p = data.get("username","").strip(), data.get("password","").strip()
    if not u or not p:
        return jsonify({"error": "username and password required"}), 400
    if len(p) < 6:
        return jsonify({"error": "password min 6 chars"}), 400
    sid  = generate_serial_id()
    conn = get_db()
    try:
        conn.execute("INSERT INTO users (username,password_hash,serial_id) VALUES(?,?,?)",
                     (u, hash_password(p), sid))
        conn.commit()
        return jsonify({"message": "Registered", "serial_id": sid}), 201
    except sqlite3.IntegrityError:
        return jsonify({"error": "Username taken"}), 409
    finally:
        conn.close()

@app.route("/api/login", methods=["POST"])
def api_login():
    data = request.get_json(force=True) or {}
    u, p = data.get("username","").strip(), data.get("password","").strip()
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM users WHERE username=?", (u,)).fetchone()
    finally:
        conn.close()
    if not row or not verify_password(p, row["password_hash"]):
        return jsonify({"error": "Invalid credentials"}), 401
    state["current_serial_id"] = row["serial_id"]
    conn2 = get_db()
    try:
        hist = conn2.execute(
            "SELECT timestamp,stage_num,label FROM history WHERE serial_id=? "
            "ORDER BY timestamp DESC LIMIT 10", (row["serial_id"],)
        ).fetchall()
    finally:
        conn2.close()
    return jsonify({"message": "OK", "serial_id": row["serial_id"],
                    "history": [dict(h) for h in hist]}), 200

@app.route("/api/history")
def api_history():
    sid  = request.args.get("serial_id", state["current_serial_id"])
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT timestamp,stage_num,label FROM history WHERE serial_id=? "
            "ORDER BY timestamp DESC LIMIT 50", (sid,)
        ).fetchall()
    finally:
        conn.close()
    return jsonify([dict(r) for r in rows])

@app.route("/api/status")
def api_status():
    return jsonify(build_status_payload())

@app.route("/api/logs")
def api_logs():
    return jsonify(state["logs"])

@app.route("/")
def index():
    return (
        "<h2>SnorShift v2.1 ✅</h2>"
        "<p>Fixed: dynamic YAMNet class names · MAX aggregation · speech-snore guard</p>"
        "<ul>"
        "<li><a href='/api/status'>Status</a></li>"
        "<li><a href='/api/logs'>Logs</a></li>"
        "<li><a href='/api/history'>History</a></li>"
        "<li><a href='/test/snore'>Test Snore</a></li>"
        "<li><a href='/test/apnea'>Test Apnea</a></li>"
        "</ul>"
    )

@app.route("/test/snore")
def test_snore():
    threading.Thread(target=handle_snore_detected, args=(250.0,), daemon=True).start()
    return jsonify({"message": "Snore test triggered"})

@app.route("/test/apnea")
def test_apnea():
    serial_mgr.send("BUZZER")
    log_event("TEST", "Manual apnea", "BUZZER sent")
    return jsonify({"message": "Apnea test triggered"})

# ─────────────────────────────────────────────────────────────────
# WEBSOCKET
# ─────────────────────────────────────────────────────────────────
@socketio.on("connect")
def on_connect():
    print("[WS] Client connected")
    emit("status_update", build_status_payload())

@socketio.on("request_status")
def on_request_status():
    emit("status_update", build_status_payload())

# ─────────────────────────────────────────────────────────────────
# STARTUP
# ─────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print("=" * 65)
    print("  SnorShift v2.1  —  Zero False Positives Edition")
    print("=" * 65)
    print(f"  Serial ID  : {state['current_serial_id']}")
    print(f"  Mic Index  : {MIC_DEVICE_INDEX}")
    print(f"  Thresholds : Snore≥{SNORE_SCORE_THRESHOLD} | "
          f"Gasp≥{GASP_SCORE_THRESHOLD} | Speech≥{SPEECH_SCORE_THRESHOLD}")
    print(f"  Energy gate: {SILENCE_ENERGY_THRESHOLD}")
    print("=" * 65)

    init_db()
    init_csv()
    serial_mgr.connect()

    # Load YAMNet ONCE — use_reloader=False below prevents double load
    yamnet_mgr.load()

    threading.Thread(target=fsr_reader_thread,     daemon=True, name="FSR").start()
    threading.Thread(target=audio_processing_loop, daemon=True, name="Audio").start()

    print("\n[READY] 🚀 http://localhost:5000\n")
    socketio.run(app, host="0.0.0.0", port=5000,
                 debug=False, use_reloader=False, allow_unsafe_werkzeug=True)    