import { useState, useEffect, useRef, useCallback } from "react";

/* ─── CHART.JS via CDN loaded once ─── */
let chartJsLoaded = false;
function loadChartJs(cb) {
  if (typeof Chart !== "undefined") { cb(); return; }
  if (chartJsLoaded) { const t = setInterval(() => { if (typeof Chart !== "undefined") { clearInterval(t); cb(); } }, 50); return; }
  chartJsLoaded = true;
  const s = document.createElement("script");
  s.src = "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js";
  s.onload = cb;
  document.head.appendChild(s);
}

/* ─── GLOBAL CSS ─── */
const GLOBAL_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Space+Mono:ital,wght@0,400;0,700;1,400&family=DM+Sans:wght@300;400;500;600&display=swap');
:root {
  --bg:#f5f6f7; --bg2:#ffffff; --bg3:#eef0f2;
  --border:rgba(30,40,60,0.08); --border2:rgba(30,40,60,0.14);
  --cyan:#1a6fff; --cyan2:#3d85ff; --cyan-dim:rgba(26,111,255,0.08);
  --red:#e53030; --red-dim:rgba(229,48,48,0.08);
  --amber:#c47d00; --amber-dim:rgba(196,125,0,0.08);
  --blue:#0d52b8; --blue-dim:rgba(13,82,184,0.08);
  --purple:#5a5fc7; --purple-dim:rgba(90,95,199,0.08);
  --text:#0d1117; --text2:#4a5568; --text3:#a0aec0;
  --mono:'Space Mono',monospace; --sans:'DM Sans',sans-serif;
  --radius:10px; --radius-lg:16px;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body,#root{height:100%;background:var(--bg);color:var(--text);font-family:var(--sans)}
body::before{content:'';position:fixed;inset:0;pointer-events:none;z-index:9999;
  background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,0.015) 2px,rgba(0,0,0,0.015) 4px);}
::-webkit-scrollbar{width:5px;height:5px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border2);border-radius:3px}
@keyframes pulse-dot{0%,100%{opacity:1}50%{opacity:.4}}
@keyframes blink-badge{0%,100%{opacity:1}50%{opacity:.4}}
@keyframes fadein{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
`;

function injectGlobalCSS() {
  if (document.getElementById("snorshift-global-css")) return;
  const style = document.createElement("style");
  style.id = "snorshift-global-css";
  style.textContent = GLOBAL_CSS;
  document.head.appendChild(style);
}

/* ══════════════════════════════════════
   HELPERS / MOCK DATA
══════════════════════════════════════ */
const API = "";
const STATUS_BADGE = {
  SENSING:        ["badge-sensing",  "● Sensing"],
  IDLE:           ["badge-idle",     "○ Idle"],
  SNORE_DETECTED: ["badge-snore",    "▲ Snore"],
  INFLATING:      ["badge-snore",    "↑ Inflating"],
  HAPTIC:         ["badge-haptic",   "⚡ Haptic"],
  APNEA:          ["badge-apnea",    "! Apnea"],
  AWAKE:          ["badge-awake",    "◉ Awake"],
};
const STAGE_MAP = {
  SENSING:        ["Silence / Light Sleep",  "Monitoring for snore patterns…"],
  SNORE_DETECTED: ["Snoring Detected!",      "Sending tilt signal to Arduino…"],
  INFLATING:      ["Snoring Detected!",      "Step A → Pillow tilt in progress…"],
  HAPTIC:         ["Escalation — Haptic",    "Vibration triggered after 3 tilts"],
  APNEA:          ["APNEA / GASPING",        "Emergency — Arduino buzzer activated"],
  AWAKE:          ["Awake / Speech",         "Session paused — user awake"],
  IDLE:           ["Idle",                   "Session not started"],
};
function getMockHistory() {
  const stages = ["Snoring","Silence / Light Sleep","Gasp/Apnea","Awake/Speech"];
  const now = new Date();
  return Array.from({length:20},(_,i)=>{
    const d = new Date(now - i*180000);
    const stage_num=[1,1,0,1,0,1,2,1,0,1,1,0,1,3,1,1,0,1,1,1][i%20];
    return {timestamp:d.toISOString(),date:d.toISOString().split("T")[0],stage_num,label:stages[stage_num]};
  });
}

/* ══════════════════════════════════════
   AUTH PAGES
══════════════════════════════════════ */
const authStyles = {
  page:{display:"flex",alignItems:"center",justifyContent:"center",
    minHeight:"100vh",background:"var(--bg)",position:"relative",overflow:"hidden"},
  blob:{position:"absolute",width:600,height:600,borderRadius:"50%",
    background:"radial-gradient(circle,rgba(26,111,255,0.06) 0%,transparent 70%)",
    top:-100,right:-100,pointerEvents:"none"},
  grid:{display:"grid",gridTemplateColumns:"1fr 1fr",width:"100%",maxWidth:900,
    minHeight:560,border:"1px solid var(--border2)",borderRadius:"var(--radius-lg)",
    overflow:"hidden",position:"relative",zIndex:1},
  brand:{background:"linear-gradient(135deg,#f0f3f8 0%,#e8edf5 100%)",
    padding:48,display:"flex",flexDirection:"column",justifyContent:"space-between",
    borderRight:"1px solid var(--border)",position:"relative",overflow:"hidden"},
  brandInner:{position:"absolute",bottom:-60,left:-60,width:280,height:280,
    borderRadius:"50%",border:"1px solid rgba(26,111,255,0.12)"},
  brandInner2:{position:"absolute",bottom:-30,left:-30,width:200,height:200,
    borderRadius:"50%",border:"1px solid rgba(26,111,255,0.07)"},
  formWrap:{background:"var(--bg2)",padding:48,display:"flex",flexDirection:"column",
    justifyContent:"center",gap:18,overflowY:"auto"},
};

function BrandPanel({subtitle,features}){
  return(
    <div style={authStyles.brand}>
      <div style={authStyles.brandInner}/>
      <div style={authStyles.brandInner2}/>
      <div>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:32}}>
          <div style={{width:36,height:36,borderRadius:8,background:"var(--cyan)",
            display:"flex",alignItems:"center",justifyContent:"center",
            fontFamily:"var(--mono)",fontWeight:700,fontSize:14,color:"#fff"}}>SS</div>
          <div>
            <div style={{fontFamily:"var(--mono)",fontSize:20,fontWeight:700}}>SnorShift</div>
            <div style={{fontSize:13,color:"var(--text2)"}}>Smart Sleep Guardian v2.2</div>
          </div>
        </div>
        <p style={{fontSize:13,color:"var(--text2)",lineHeight:1.7,marginBottom:28}}>{subtitle}</p>
        <ul style={{listStyle:"none",display:"flex",flexDirection:"column",gap:12}}>
          {features.map((f,i)=>(
            <li key={i} style={{fontSize:13,color:"var(--text2)",display:"flex",alignItems:"center",gap:10}}>
              <span style={{width:6,height:6,borderRadius:"50%",background:"var(--cyan)",flexShrink:0,display:"inline-block"}}/>
              {f}
            </li>
          ))}
        </ul>
      </div>
      <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--text3)"}}>SnorShift — Hackathon Edition {new Date().getFullYear()}</div>
    </div>
  );
}

function InputGroup({label,labelExtra,id,type,placeholder,value,onChange,onKeyDown,inputStyle}){
  return(
    <div style={{display:"flex",flexDirection:"column",gap:8}}>
      <label style={{fontSize:12,color:"var(--text2)",fontFamily:"var(--mono)",
        letterSpacing:".06em",textTransform:"uppercase"}}>
        {label}{labelExtra&&<span style={{color:"var(--text3)"}}> {labelExtra}</span>}
      </label>
      <input id={id} type={type} placeholder={placeholder} value={value} onChange={onChange}
        onKeyDown={onKeyDown} autoComplete={type==="password"?"current-password":"username"}
        style={{background:"var(--bg3)",border:"1px solid var(--border2)",borderRadius:"var(--radius)",
          padding:"11px 14px",color:"var(--text)",fontFamily:"var(--sans)",fontSize:14,outline:"none",
          transition:"border-color .2s,box-shadow .2s",...inputStyle}}
        onFocus={e=>{e.target.style.borderColor="var(--cyan)";e.target.style.boxShadow="0 0 0 3px rgba(26,111,255,0.08)"}}
        onBlur={e=>{e.target.style.borderColor="var(--border2)";e.target.style.boxShadow="none"}}
      />
    </div>
  );
}

function ErrorMsg({msg}){
  if(!msg) return null;
  return <div style={{fontSize:12,color:"var(--red)",background:"var(--red-dim)",
    border:"1px solid rgba(229,48,48,0.15)",borderRadius:8,padding:"8px 12px"}}>{msg}</div>;
}
function SuccessMsg({msg}){
  if(!msg) return null;
  return <div style={{fontSize:12,color:"var(--cyan)",background:"var(--cyan-dim)",
    border:"1px solid rgba(26,111,255,0.15)",borderRadius:8,padding:"8px 12px"}}>{msg}</div>;
}

function LoginPage({onLogin}){
  const [user,setUser]=useState("");
  const [pass,setPass]=useState("");
  const [err,setErr]=useState("");
  const [loading,setLoading]=useState(false);

  async function doLogin(){
    if(!user||!pass){setErr("Username and password required");return;}
    setLoading(true); setErr("");
    try{
      const r=await fetch(API+"/api/login",{method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({username:user,password:pass})});
      const data=await r.json();
      if(!r.ok){setErr(data.error||"Login failed");setLoading(false);return;}
      onLogin(user,data.serial_id||"GP-A4F2",data.history||[]);
    }catch{
      onLogin(user||"demo_user","GP-A4F2",[]);
    }
    setLoading(false);
  }
  const onKey=e=>{if(e.key==="Enter")doLogin();};

  return(
    <div style={authStyles.page}>
      <div style={authStyles.blob}/>
      <div style={authStyles.grid}>
        <BrandPanel
          subtitle="AI-powered snore detection and intelligent pillow control. Sleep better, breathe safer."
          features={["Real-time YAMNet audio classification","Automatic tilt intervention (3-stage)",
            "Apnea / gasp emergency detection","Live FFT waveform visualization",
            "60-day encrypted sleep history","Arduino hardware integration"]}
        />
        <div style={authStyles.formWrap}>
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            <h2 style={{fontFamily:"var(--mono)",fontSize:22,fontWeight:700}}>Welcome back</h2>
            <p style={{fontSize:14,color:"var(--text2)"}}>Sign in to your sleep dashboard</p>
          </div>
          <ErrorMsg msg={err}/>
          <InputGroup label="Username" type="text" placeholder="your_username" value={user} onChange={e=>setUser(e.target.value)} onKeyDown={onKey}/>
          <InputGroup label="Password" type="password" placeholder="••••••••" value={pass} onChange={e=>setPass(e.target.value)} onKeyDown={onKey}/>
          <button onClick={doLogin} disabled={loading}
            style={{background:"var(--cyan)",color:"#fff",fontFamily:"var(--mono)",fontWeight:700,
              fontSize:13,letterSpacing:".04em",padding:13,border:"none",borderRadius:"var(--radius)",
              cursor:"pointer",textTransform:"uppercase",opacity:loading?.7:1}}>
            {loading?"Signing in…":"Sign In →"}
          </button>
          <p style={{fontSize:13,color:"var(--text2)",textAlign:"center"}}>
            No account?{" "}
            <a onClick={()=>window._snorShiftSetPage("register")}
              style={{color:"var(--cyan)",cursor:"pointer",textDecoration:"none"}}>Create one</a>
          </p>
        </div>
      </div>
    </div>
  );
}

function RegisterPage(){
  const [user,setUser]=useState("");
  const [pass,setPass]=useState("");
  const [serial,setSerial]=useState("");
  const [err,setErr]=useState("");
  const [success,setSuccess]=useState("");

  async function doRegister(){
    if(!user||!pass){setErr("All fields required");return;}
    if(pass.length<6){setErr("Password must be at least 6 characters");return;}
    if(!serial){setErr("Device Serial Number is required");return;}
    const s=serial.trim().toUpperCase();
    if(!/^[A-Z0-9]{2}-[A-Z0-9]{4,8}$/.test(s)){setErr("Invalid serial format. Example: GP-A4F2");return;}
    setErr("");
    try{
      const r=await fetch(API+"/api/register",{method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({username:user,password:pass,serial_id:s})});
      const data=await r.json();
      if(!r.ok){setErr(data.error||"Registration failed");return;}
      setSuccess(`✓ Account created! Device ID: ${data.serial_id||s} — Redirecting…`);
      setTimeout(()=>window._snorShiftSetPage("login"),2000);
    }catch{
      setSuccess(`Demo mode — Device ID: ${s} — Redirecting to login…`);
      setTimeout(()=>window._snorShiftSetPage("login"),2500);
    }
  }
  const onKey=e=>{if(e.key==="Enter")doRegister();};

  return(
    <div style={authStyles.page}>
      <div style={authStyles.blob}/>
      <div style={authStyles.grid}>
        <BrandPanel
          subtitle="Create your account to start monitoring your sleep and controlling your guardian pillow."
          features={["Each device gets a unique Serial ID","Personal sleep history stored securely",
            "Download CSV reports anytime","Multi-device support coming soon"]}
        />
        <div style={authStyles.formWrap}>
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            <h2 style={{fontFamily:"var(--mono)",fontSize:22,fontWeight:700}}>Create account</h2>
            <p style={{fontSize:14,color:"var(--text2)"}}>Your personal sleep guardian profile</p>
          </div>
          <ErrorMsg msg={err}/>
          <SuccessMsg msg={success}/>
          <InputGroup label="Username" type="text" placeholder="choose_username" value={user} onChange={e=>setUser(e.target.value)} onKeyDown={onKey}/>
          <InputGroup label="Password" labelExtra="(min 6 chars)" type="password" placeholder="••••••••" value={pass} onChange={e=>setPass(e.target.value)} onKeyDown={onKey}/>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            <label style={{fontSize:12,color:"var(--text2)",fontFamily:"var(--mono)",
              letterSpacing:".06em",textTransform:"uppercase"}}>Device Serial Number</label>
            <input type="text" placeholder="e.g. GP-A4F2" value={serial}
              onChange={e=>setSerial(e.target.value.toUpperCase())} onKeyDown={onKey}
              style={{background:"var(--bg3)",border:"1px solid var(--border2)",borderRadius:"var(--radius)",
                padding:"11px 14px",color:"var(--text)",fontFamily:"var(--mono)",fontSize:13,outline:"none",
                letterSpacing:".06em",textTransform:"uppercase",transition:"border-color .2s"}}
              onFocus={e=>{e.target.style.borderColor="var(--cyan)";e.target.style.boxShadow="0 0 0 3px rgba(26,111,255,0.08)"}}
              onBlur={e=>{e.target.style.borderColor="var(--border2)";e.target.style.boxShadow="none"}}
            />
            <span style={{fontSize:11,color:"var(--text3)"}}>📟 Enter the serial printed on your SnorShift pillow device</span>
          </div>
          <button onClick={doRegister}
            style={{background:"var(--cyan)",color:"#fff",fontFamily:"var(--mono)",fontWeight:700,
              fontSize:13,letterSpacing:".04em",padding:13,border:"none",borderRadius:"var(--radius)",
              cursor:"pointer",textTransform:"uppercase"}}>
            Create Account →
          </button>
          <p style={{fontSize:13,color:"var(--text2)",textAlign:"center"}}>
            Already have an account?{" "}
            <a onClick={()=>window._snorShiftSetPage("login")}
              style={{color:"var(--cyan)",cursor:"pointer",textDecoration:"none"}}>Sign in</a>
          </p>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════
   DASHBOARD
══════════════════════════════════════ */
function Dashboard({user,serial,initialHistory,onLogout}){
  const [activeTab,setActiveTab]=useState("live");
  const [wsConnected,setWsConnected]=useState(false);
  const [status,setStatus]=useState("SENSING");
  const [lastAction,setLastAction]=useState("System started");
  const [snoreCount,setSnoreCount]=useState(0);
  const [sessionTime,setSessionTime]=useState("00:00:00");
  const [tiltLevel,setTiltLevel]=useState(0);
  const [tiltCount,setTiltCount]=useState(0);
  const [hapticOn,setHapticOn]=useState(false);
  const [apneaElapsed,setApneaElapsed]=useState(0);
  const [apneaThreshold,setApneaThreshold]=useState(15);
  const [fsrState,setFsrState]=useState("FSR_C");
  const [logRows,setLogRows]=useState([]);
  const [showCountdown,setShowCountdown]=useState(false);
  const [countdownNum,setCountdownNum]=useState(10);
  const [fftMags,setFftMags]=useState(Array(60).fill(0.04));
  const [fftDomHz,setFftDomHz]=useState(0);
  const [fftEnergy,setFftEnergy]=useState(0);
  const [historyRows,setHistoryRows]=useState(initialHistory||[]);
  const [stageCounts,setStageCounts]=useState([0,0,0,0]);
  const [histDate,setHistDate]=useState("");
  const [showEmergency,setShowEmergency]=useState(false);

  const wsRef=useRef(null);
  const mockFftRef=useRef(null);
  const countdownRef=useRef(null);
  const chartRef=useRef(null);
  const chartCanvasRef=useRef(null);
  const stageCountsRef=useRef([0,0,0,0]);

  /* FFT */
  function startMockFft(){
    clearInterval(mockFftRef.current);
    mockFftRef.current=setInterval(()=>{
      if(wsRef.current&&wsRef.current.readyState===1) return;
      const mags=Array.from({length:200},(_,i)=>{
        const hz=i*3; let v=Math.random()*0.08;
        if(hz>80&&hz<180) v+=Math.random()*0.2;
        if(hz>200&&hz<350) v+=Math.sin(Date.now()/800+i)*0.1+0.1;
        return Math.max(0,Math.min(1,v));
      });
      const domHz=248+Math.sin(Date.now()/2000)*20;
      const energy=0.003+Math.random()*0.001;
      const step=Math.floor(mags.length/60);
      setFftMags(Array.from({length:60},(_,i)=>mags[i*step]||0));
      setFftDomHz(domHz);
      setFftEnergy(energy);
    },120);
  }

  /* WebSocket */
  function connectWebSocket(){
    const wsUrl=window.location.origin.replace("http","ws")+"/socket.io/?EIO=4&transport=websocket";
    try{
      const ws=new WebSocket(wsUrl);
      wsRef.current=ws;
      ws.onopen=()=>{
        setWsConnected(true);
        ws.send("40"); // Socket.IO connect packet
      };
      ws.onclose=()=>{setWsConnected(false);setTimeout(connectWebSocket,3000);};
      ws.onerror=()=>setWsConnected(false);
      ws.onmessage=(e)=>{
        try{
          const raw=e.data;
          let event,data;
          // Socket.IO EIO4 format: 42["event", data]
          if(typeof raw==="string"&&raw.startsWith("42")){
            [event,data]=JSON.parse(raw.slice(2));
          } else {
            // fallback: plain JSON {event, data}
            const parsed=JSON.parse(raw);
            event=parsed.event; data=parsed.data;
          }
          if(event==="status_update") applyStatus(data);
          if(event==="fft_update"&&data.magnitudes){
            const m=data.magnitudes; const step=Math.floor(m.length/60);
            setFftMags(Array.from({length:60},(_,i)=>m[i*step]||0));
            setFftDomHz(data.dominant_hz||0);
            setFftEnergy(data.energy||0);
          }
          if(event==="log_update") addLogRow(data);
          if(event==="apnea_timer"){setApneaElapsed(data.elapsed);setApneaThreshold(data.threshold);}
          if(event==="countdown_start") startCountdown(data.seconds);
        }catch{}
      };
    }catch{setWsConnected(false);}
  }

  function applyStatus(d){
    const s=d.status||"IDLE";
    setStatus(s); setLastAction(d.last_action||"—");
    setSnoreCount(d.snore_count||0);
    setSessionTime(d.session_time||"00:00:00");
    setTiltLevel(d.inflation_level||0);
    setTiltCount(d.arduino_tilt_count||0);
    setHapticOn(!!d.arduino_haptic);
    setFsrState(d.fsr_state||"FSR_C");
    setShowEmergency(s==="APNEA");
    const stageNum={SENSING:1,SNORE_DETECTED:0,INFLATING:0,HAPTIC:0,APNEA:2,AWAKE:3}[s];
    if(stageNum!==undefined){
      stageCountsRef.current=stageCountsRef.current.map((v,i)=>i===stageNum?v+1:v);
      setStageCounts([...stageCountsRef.current]);
    }
  }

  function addLogRow(d){
    setLogRows(prev=>{
      const s=STATUS_BADGE[status]?.[1]||"—";
      const [cls]=STATUS_BADGE[status]||["badge-idle"];
      const row={time:d.time||"—",event:d.event||"—",action:d.action||"—",result:d.result||"—",badgeCls:cls,badgeLabel:s};
      return [row,...prev].slice(0,50);
    });
  }

  function startCountdown(sec){
    clearInterval(countdownRef.current);
    let rem=sec; setShowCountdown(true); setCountdownNum(rem);
    countdownRef.current=setInterval(()=>{
      rem--; setCountdownNum(rem);
      if(rem<=0){clearInterval(countdownRef.current);setShowCountdown(false);}
    },1000);
  }

  /* Chart */
  useEffect(()=>{
    if(activeTab!=="history") return;
    loadChartJs(()=>{
      if(!chartCanvasRef.current) return;
      if(chartRef.current){chartRef.current.destroy();chartRef.current=null;}
      chartRef.current=new Chart(chartCanvasRef.current,{
        type:"doughnut",
        data:{
          labels:["Snoring","Silence/Light","Gasp/Apnea","Awake/Speech"],
          datasets:[{data:[...stageCounts],
            backgroundColor:["rgba(196,125,0,0.85)","rgba(26,111,255,0.75)","rgba(229,48,48,0.85)","rgba(13,82,184,0.75)"],
            borderColor:"transparent",borderWidth:0,hoverOffset:8}]
        },
        options:{responsive:true,maintainAspectRatio:false,
          plugins:{legend:{display:false},tooltip:{callbacks:{label:(ctx)=>` ${ctx.label}: ${ctx.parsed} detections`}}},
          cutout:"65%"}
      });
    });
    return()=>{if(chartRef.current){chartRef.current.destroy();chartRef.current=null;}};
  },[activeTab]);

  useEffect(()=>{
    if(chartRef.current){chartRef.current.data.datasets[0].data=[...stageCounts];chartRef.current.update("none");}
  },[stageCounts]);

  /* Init */
  useEffect(()=>{
    startMockFft();
    connectWebSocket();
    if(!initialHistory||!initialHistory.length) setHistoryRows(getMockHistory());
    return()=>{
      clearInterval(mockFftRef.current);
      clearInterval(countdownRef.current);
      if(wsRef.current) wsRef.current.close();
    };
  },[]);

  /* Load History */
  async function loadHistory(){
    let url=API+"/api/history?serial_id="+encodeURIComponent(serial);
    if(histDate) url=API+"/api/download_history?serial_id="+encodeURIComponent(serial)+"&date="+histDate;
    try{
      const r=await fetch(url);
      if(!r.ok) throw new Error();
      if(histDate){const text=await r.text();parseCsvHistory(text);}
      else{const rows=await r.json();setHistoryRows(rows);}
    }catch{setHistoryRows(getMockHistory());}
  }
  function parseCsvHistory(csv){
    const lines=csv.split("\n").filter(l=>l.trim()&&!l.startsWith("Date"));
    const rows=lines.map(l=>{
      const [date,time,stage_num,label]=l.split(",");
      return{timestamp:date+"T"+(time||""),date,stage_num:parseInt(stage_num)||0,label};
    });
    setHistoryRows(rows);
  }
  async function downloadHistory(){
    let url=API+"/api/download_history?serial_id="+encodeURIComponent(serial);
    if(histDate) url+="&date="+encodeURIComponent(histDate);
    try{
      const r=await fetch(url); if(!r.ok) throw new Error();
      const blob=await r.blob();
      const a=document.createElement("a"); a.href=URL.createObjectURL(blob);
      a.download="sleep_history_"+serial+(histDate?"_"+histDate:"")+".csv"; a.click();
      URL.revokeObjectURL(a.href);
    }catch{
      const rows=getMockHistory(); let csv="Date,Time,Stage,Detection\n";
      rows.forEach(r=>{const[d,t]=r.timestamp.split("T");csv+=`${d},${t?.split(".")[0]||""},${r.stage_num},${r.label}\n`;});
      const blob=new Blob([csv],{type:"text/csv"});
      const a=document.createElement("a"); a.href=URL.createObjectURL(blob);
      a.download="sleep_history_"+serial+".csv"; a.click();
      URL.revokeObjectURL(a.href);
    }
  }

  /* Test controls */
  async function testSnore(){
    try{await fetch(API+"/test/snore");}catch{}
    addLogRow({time:new Date().toTimeString().slice(0,8),event:"TEST Snore",action:"Triggered manually",result:"Demo mode"});
    applyStatus({status:"SNORE_DETECTED",snore_count:1,inflation_level:1,session_time:"00:05:00",last_action:"Test snore triggered",fsr_state:"FSR_C",arduino_tilt_count:1,arduino_haptic:false});
  }
  async function testApnea(){
    try{await fetch(API+"/test/apnea");}catch{}
    addLogRow({time:new Date().toTimeString().slice(0,8),event:"TEST Apnea",action:"Manual apnea test",result:"Signal 1 sent"});
    applyStatus({status:"APNEA",snore_count:2,inflation_level:2,session_time:"00:05:00",last_action:"Apnea test fired",fsr_state:"FSR_L",arduino_tilt_count:2,arduino_haptic:true});
  }

  const [badgeCls,badgeLabel]=STATUS_BADGE[status]||STATUS_BADGE.IDLE;
  const [stageText,stageSub]=STAGE_MAP[status]||STAGE_MAP.IDLE;
  const apneaPct=Math.min(100,(apneaElapsed/apneaThreshold)*100);

  return(
    <div style={{display:"flex",flexDirection:"column",minHeight:"100vh"}}>
      {/* TOPBAR */}
      <div style={{height:54,background:"var(--bg2)",borderBottom:"1px solid var(--border)",
        display:"flex",alignItems:"center",justifyContent:"space-between",padding:"0 24px",
        flexShrink:0,position:"sticky",top:0,zIndex:100}}>
        <div style={{display:"flex",alignItems:"center",gap:16}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <div style={{width:26,height:26,borderRadius:6,background:"var(--cyan)",
              display:"flex",alignItems:"center",justifyContent:"center",
              fontFamily:"var(--mono)",fontWeight:700,fontSize:10,color:"#fff"}}>SS</div>
            <span style={{fontFamily:"var(--mono)",fontWeight:700,fontSize:15}}>SnorShift</span>
          </div>
          <div style={{display:"flex",gap:4}}>
            {["live","hardware","history"].map(tab=>(
              <button key={tab} onClick={()=>{setActiveTab(tab);if(tab==="history")loadHistory();}}
                style={{background:activeTab===tab?"var(--cyan-dim)":"transparent",
                  border:"none",color:activeTab===tab?"var(--cyan)":"var(--text2)",
                  fontFamily:"var(--sans)",fontSize:13,padding:"6px 14px",borderRadius:7,cursor:"pointer"}}>
                {tab.charAt(0).toUpperCase()+tab.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <div style={{width:8,height:8,borderRadius:"50%",
            background:wsConnected?"var(--cyan)":"var(--text3)",
            boxShadow:wsConnected?"0 0 6px var(--cyan)":"none",
            animation:wsConnected?"pulse-dot 2s infinite":"none"}}/>
          <div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--cyan)",
            background:"var(--cyan-dim)",border:"1px solid rgba(26,111,255,0.15)",
            padding:"4px 10px",borderRadius:20}}>{serial}</div>
          <span style={{fontSize:12,color:"var(--text2)"}}>{user}</span>
          <button onClick={onLogout}
            style={{background:"transparent",border:"1px solid var(--border2)",color:"var(--text2)",
              fontFamily:"var(--mono)",fontSize:11,padding:"5px 12px",borderRadius:7,cursor:"pointer"}}
            onMouseOver={e=>{e.target.style.borderColor="var(--red)";e.target.style.color="var(--red)";}}
            onMouseOut={e=>{e.target.style.borderColor="var(--border2)";e.target.style.color="var(--text2)";}}>
            Logout
          </button>
        </div>
      </div>

      {/* DASH BODY */}
      <div style={{flex:1,overflow:"auto",padding:24,display:"flex",flexDirection:"column",gap:20}}>

        {/* EMERGENCY BANNER */}
        {showEmergency&&(
          <div style={{background:"linear-gradient(90deg,rgba(229,48,48,.12),rgba(255,77,106,.08))",
            border:"1px solid rgba(229,48,48,.35)",borderRadius:"var(--radius-lg)",
            padding:"16px 20px",display:"flex",alignItems:"center",gap:14,
            animation:"blink-badge .8s infinite"}}>
            <div style={{width:36,height:36,borderRadius:"50%",background:"var(--red-dim)",
              border:"1px solid rgba(229,48,48,.25)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,flexShrink:0}}>⚠</div>
            <div>
              <strong style={{fontFamily:"var(--mono)",fontSize:13,color:"var(--red)",display:"block",textTransform:"uppercase",letterSpacing:".05em"}}>Apnea Alert — Immediate Action Required</strong>
              <span style={{fontSize:12,color:"var(--text2)"}}>Arduino buzzer has fired. No breathing detected. Please wake the user.</span>
            </div>
          </div>
        )}

        {/* TAB: LIVE */}
        {activeTab==="live"&&(
          <div style={{display:"flex",flexDirection:"column",gap:20,animation:"fadein .25s ease"}}>
            {/* Metrics */}
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:14}}>
              {[
                {label:"System Status",accent:null,content:<><div style={{marginTop:6}}><span className={`badge badge-${badgeCls.replace("badge-","")}`} style={badgeStyle(badgeCls)}>{badgeLabel}</span></div><div style={{fontSize:11,color:"var(--text2)",marginTop:6}}>{lastAction}</div></>},
                {label:"Snore Count",accent:"var(--red)",content:<><div style={{fontFamily:"var(--mono)",fontSize:26,fontWeight:700,lineHeight:1}}>{snoreCount}</div><div style={{fontSize:11,color:"var(--text2)",marginTop:6}}>tonight's detections</div></>},
                {label:"Session Time",accent:"var(--blue)",content:<><div style={{fontFamily:"var(--mono)",fontSize:20,fontWeight:700,lineHeight:1}}>{sessionTime}</div><div style={{fontSize:11,color:"var(--text2)",marginTop:6}}>active session</div></>},
                {label:"Tilt Level",accent:"var(--amber)",content:<><div style={{fontFamily:"var(--mono)",fontSize:26,fontWeight:700,lineHeight:1}}>{tiltLevel} / 3</div><div style={{fontSize:11,color:"var(--text2)",marginTop:6}}>interventions used</div></>},
              ].map((m,i)=>(
                <div key={i} style={{background:"var(--bg2)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",
                  padding:"18px 20px",position:"relative",overflow:"hidden"}}>
                  {m.accent&&<div style={{position:"absolute",top:0,left:0,right:0,height:2,background:m.accent,borderRadius:"2px 2px 0 0"}}/>}
                  <div style={{fontSize:11,color:"var(--text3)",fontFamily:"var(--mono)",letterSpacing:".06em",textTransform:"uppercase",marginBottom:8}}>{m.label}</div>
                  {m.content}
                </div>
              ))}
            </div>

            {/* FFT + Sleep Stage */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
              <Card title="Live Audio — FFT Spectrum">
                <div style={{position:"relative",height:120,overflow:"hidden"}}>
                  <div style={{position:"absolute",top:4,right:6,fontFamily:"var(--mono)",fontSize:11,color:"var(--cyan)"}}>{Math.round(fftDomHz)} Hz</div>
                  <div style={{display:"flex",alignItems:"flex-end",gap:2,height:"100%",paddingBottom:20}}>
                    {fftMags.map((v,i)=>{
                      const hz=(i/60)*600;
                      const color=(hz>=100&&hz<=500)
                        ?`rgba(196,125,0,${0.4+v*0.6})`:`rgba(26,111,255,${0.3+v*0.7})`;
                      return<div key={i} style={{flex:1,minWidth:3,borderRadius:"2px 2px 0 0",
                        background:color,opacity:.7,height:Math.max(4,v*96)+"%",transition:"height .08s ease"}}/>;
                    })}
                  </div>
                  <div style={{position:"absolute",bottom:0,left:0,right:0,display:"flex",justifyContent:"space-between",
                    fontFamily:"var(--mono)",fontSize:10,color:"var(--text3)",padding:"0 2px"}}>
                    <span>0 Hz</span><span>Energy: {fftEnergy.toFixed(6)}</span><span>600 Hz</span>
                  </div>
                </div>
              </Card>
              <Card title="Current Sleep Stage">
                <div style={{display:"flex",flexDirection:"column",gap:12,marginTop:4}}>
                  <div style={{fontFamily:"var(--mono)",fontSize:16,color:"var(--cyan)",fontWeight:700}}>{stageText}</div>
                  <div style={{fontSize:12,color:"var(--text2)"}}>{stageSub}</div>
                  <div>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                      <span style={{fontSize:11,color:"var(--text3)",fontFamily:"var(--mono)"}}>Apnea timer</span>
                      <span style={{fontSize:11,color:"var(--text3)",fontFamily:"var(--mono)"}}>{apneaElapsed.toFixed(1)} / {apneaThreshold}s</span>
                    </div>
                    <div style={{height:6,background:"var(--bg3)",borderRadius:3,overflow:"hidden",border:"1px solid var(--border)"}}>
                      <div style={{height:"100%",width:apneaPct+"%",background:apneaPct>60?"var(--red)":"var(--cyan)",borderRadius:3,transition:"width .5s linear"}}/>
                    </div>
                  </div>
                  {showCountdown&&(
                    <div style={{background:"var(--bg3)",border:"1px solid var(--border2)",borderRadius:"var(--radius)",
                      padding:"12px 16px",display:"flex",alignItems:"center",gap:12,fontFamily:"var(--mono)"}}>
                      <div style={{fontSize:28,fontWeight:700,color:"var(--cyan)",minWidth:36,textAlign:"center"}}>{countdownNum}</div>
                      <div>
                        <div style={{fontSize:12,color:"var(--text)",fontFamily:"var(--mono)",fontWeight:700}}>Step B — Verification</div>
                        <div style={{fontSize:11,color:"var(--text2)"}}>Waiting for pillow tilt to take effect…</div>
                      </div>
                    </div>
                  )}
                </div>
              </Card>
            </div>

            {/* Intervention Flow */}
            <Card title="Intervention Flow">
              <StepFlow status={status}/>
            </Card>

            {/* Event Log */}
            <Card title={<span>Event Log <span style={{fontSize:10,color:"var(--text3)",float:"right"}}>{logRows.length} events</span></span>}>
              <div style={{overflowY:"auto",maxHeight:220}}>
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                  <thead>
                    <tr>
                      {["Time","Event","Action","Result","Status"].map(h=>(
                        <th key={h} style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--text3)",
                          textTransform:"uppercase",letterSpacing:".06em",padding:"0 10px 10px",
                          textAlign:"left",borderBottom:"1px solid var(--border)"}}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {logRows.map((r,i)=>(
                      <tr key={i}>
                        <td style={{padding:"9px 10px",color:"var(--text3)",fontFamily:"var(--mono)",fontSize:11,borderBottom:"1px solid rgba(0,0,0,0.03)"}}>{r.time}</td>
                        <td style={{padding:"9px 10px",color:"var(--text)",fontWeight:500,borderBottom:"1px solid rgba(0,0,0,0.03)"}}>{r.event}</td>
                        <td style={{padding:"9px 10px",color:"var(--text2)",borderBottom:"1px solid rgba(0,0,0,0.03)"}}>{r.action}</td>
                        <td style={{padding:"9px 10px",color:"var(--text3)",borderBottom:"1px solid rgba(0,0,0,0.03)"}}>{r.result}</td>
                        <td style={{padding:"9px 10px",borderBottom:"1px solid rgba(0,0,0,0.03)"}}><span style={badgeStyle(r.badgeCls)}>{r.badgeLabel}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {logRows.length===0&&<div style={{textAlign:"center",padding:40,fontFamily:"var(--mono)",fontSize:13,color:"var(--text3)"}}>
                  <span style={{display:"block",fontSize:28,marginBottom:8,opacity:.3}}>📋</span>No events yet — connect to backend
                </div>}
              </div>
            </Card>
          </div>
        )}

        {/* TAB: HARDWARE */}
        {activeTab==="hardware"&&(
          <div style={{display:"flex",flexDirection:"column",gap:20,animation:"fadein .25s ease"}}>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
              <Card title="Head Position (FSR Sensors)">
                <PillowSVG fsrState={fsrState}/>
              </Card>
              <Card title="Tilt Interventions">
                <div style={{marginBottom:16}}>
                  <div style={{fontSize:11,color:"var(--text2)",marginBottom:10}}>Tilts used this session</div>
                  <div style={{display:"flex",gap:8,alignItems:"center"}}>
                    {[1,2,3].map(n=>{
                      const filled=n<tiltCount; const current=n===tiltCount&&tiltCount>0;
                      return<div key={n} style={{width:32,height:32,borderRadius:"50%",
                        border:`2px solid ${current?"var(--cyan)":filled?"var(--amber)":"var(--border2)"}`,
                        display:"flex",alignItems:"center",justifyContent:"center",
                        fontFamily:"var(--mono)",fontSize:11,
                        color:current?"var(--cyan)":filled?"var(--amber)":"var(--text3)",
                        background:current?"var(--cyan-dim)":filled?"var(--amber-dim)":"transparent",
                        boxShadow:current?"0 0 8px rgba(26,111,255,.18)":filled?"0 0 8px rgba(196,125,0,.18)":"none",
                        animation:current?"pulse-dot 1.2s infinite":"none"}}>{n}</div>;
                    })}
                  </div>
                  <div style={{fontSize:11,color:"var(--text3)",marginTop:10,fontFamily:"var(--mono)"}}>After 3 tilts → haptic vibration triggered</div>
                </div>
                <div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--text3)",letterSpacing:".08em",textTransform:"uppercase",marginBottom:14,marginTop:16}}>Haptic / Alert State</div>
                <div style={{display:"flex",flexWrap:"wrap",gap:8,alignItems:"center"}}>
                  <HwChip label="Haptic" val={hapticOn?"ACTIVE":"OFF"} ledClass={hapticOn?"warn":"off"}/>
                  <HwChip label="Buzzer" val="OK" ledClass="off"/>
                </div>
              </Card>
            </div>
            <Card title="Arduino Connection">
              <div style={{display:"flex",flexWrap:"wrap",gap:8,alignItems:"center"}}>
                <HwChip label="Port" val="COM5" ledClass="on"/>
                <HwChip label="Baud" val="9600" ledClass="on"/>
                <HwChip label="Status" val="Connected" ledClass="on"/>
                <HwChip label="Mic Index" val="1" ledClass="on"/>
                <HwChip label="YAMNet" val="Loaded" ledClass="on"/>
              </div>
            </Card>
            <Card title="Test Controls">
              <div style={{display:"flex",flexWrap:"wrap",gap:12,alignItems:"center"}}>
                <button onClick={testSnore} style={{background:"transparent",color:"var(--cyan)",
                  border:"1px solid var(--border2)",fontFamily:"var(--mono)",fontSize:12,padding:"11px 16px",
                  borderRadius:"var(--radius)",cursor:"pointer",letterSpacing:".04em",textTransform:"uppercase"}}
                  onMouseOver={e=>e.currentTarget.style.background="var(--cyan-dim)"}
                  onMouseOut={e=>e.currentTarget.style.background="transparent"}>
                  ▶ Test Snore
                </button>
                <button onClick={testApnea} style={{background:"transparent",color:"var(--red)",
                  border:"1px solid rgba(229,48,48,.25)",fontFamily:"var(--mono)",fontSize:12,padding:"11px 16px",
                  borderRadius:"var(--radius)",cursor:"pointer",letterSpacing:".04em",textTransform:"uppercase"}}
                  onMouseOver={e=>e.currentTarget.style.background="var(--red-dim)"}
                  onMouseOut={e=>e.currentTarget.style.background="transparent"}>
                  ⚠ Test Apnea
                </button>
                <span style={{fontSize:11,color:"var(--text3)"}}>Triggers backend test endpoints for live demo</span>
              </div>
            </Card>
          </div>
        )}

        {/* TAB: HISTORY */}
        {activeTab==="history"&&(
          <div style={{display:"flex",flexDirection:"column",gap:20,animation:"fadein .25s ease"}}>
            <Card title="Sleep Stage Distribution — This Session">
              <div style={{position:"relative",height:220}}>
                <canvas ref={chartCanvasRef}/>
              </div>
              <div style={{display:"flex",flexWrap:"wrap",gap:12,marginTop:12}}>
                {[["var(--amber)","Snoring"],["var(--cyan)","Silence / Light Sleep"],["var(--red)","Gasp / Apnea"],["var(--blue)","Awake / Speech"]].map(([c,l])=>(
                  <div key={l} style={{display:"flex",alignItems:"center",gap:6,fontSize:12,color:"var(--text2)"}}>
                    <div style={{width:8,height:8,borderRadius:"50%",background:c,flexShrink:0}}/>
                    {l}
                  </div>
                ))}
              </div>
            </Card>
            <Card title="Download History">
              <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <label style={{fontSize:11,color:"var(--text2)",fontFamily:"var(--mono)",whiteSpace:"nowrap"}}>Filter by date</label>
                  <input type="date" value={histDate} onChange={e=>setHistDate(e.target.value)}
                    style={{background:"var(--bg3)",border:"1px solid var(--border2)",color:"var(--text)",
                      fontFamily:"var(--mono)",fontSize:12,padding:"8px 12px",borderRadius:"var(--radius)",outline:"none"}}/>
                </div>
                <button onClick={loadHistory} style={{background:"var(--bg3)",border:"1px solid var(--border2)",
                  color:"var(--text)",fontFamily:"var(--mono)",fontSize:11,padding:"8px 14px",borderRadius:"var(--radius)",
                  cursor:"pointer",letterSpacing:".04em",textTransform:"uppercase"}}>Apply Filter</button>
                <button onClick={downloadHistory} style={{display:"flex",alignItems:"center",gap:7,
                  background:"var(--cyan)",color:"#fff",fontFamily:"var(--mono)",fontWeight:700,fontSize:11,
                  letterSpacing:".05em",padding:"9px 16px",border:"none",borderRadius:"var(--radius)",
                  cursor:"pointer",textTransform:"uppercase"}}>
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 2v8M5 7l3 3 3-3M3 12h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                  Download CSV
                </button>
                <button onClick={loadHistory} style={{marginLeft:"auto",background:"var(--bg3)",border:"1px solid var(--border2)",
                  color:"var(--text)",fontFamily:"var(--mono)",fontSize:11,padding:"8px 14px",borderRadius:"var(--radius)",
                  cursor:"pointer",letterSpacing:".04em",textTransform:"uppercase"}}>↺ Refresh</button>
              </div>
            </Card>
            <Card title={<span>Sleep Records <span style={{fontSize:10,color:"var(--text3)",float:"right"}}>{historyRows.length} records</span></span>}>
              <div style={{overflowX:"auto"}}>
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
                  <thead>
                    <tr>{["#","Date","Time","Stage","Detection"].map(h=>(
                      <th key={h} style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--text3)",
                        textTransform:"uppercase",letterSpacing:".06em",padding:"0 14px 12px",
                        textAlign:"left",borderBottom:"1px solid var(--border)",whiteSpace:"nowrap"}}>{h}</th>
                    ))}</tr>
                  </thead>
                  <tbody>
                    {historyRows.map((row,i)=>{
                      const ts=row.timestamp||"";
                      const datePart=row.date||ts.split("T")[0]||"—";
                      const timePart=ts.split("T")[1]?.split(".")[0]||"—";
                      const sn=parseInt(row.stage_num)||0;
                      const sLabels=["Snoring","Silence","Gasp/Apnea","Awake"];
                      const sCls=["var(--amber)","var(--cyan)","var(--red)","var(--blue)"];
                      const sBg=["rgba(196,125,0,.1)","rgba(26,111,255,.07)","rgba(229,48,48,.12)","rgba(13,82,184,.09)"];
                      return(
                        <tr key={i}>
                          <td style={{padding:"11px 14px",color:"var(--text3)",fontFamily:"var(--mono)",fontSize:11,borderBottom:"1px solid rgba(0,0,0,0.03)"}}>{historyRows.length-i}</td>
                          <td style={{padding:"11px 14px",color:"var(--text2)",borderBottom:"1px solid rgba(0,0,0,0.03)"}}>{datePart}</td>
                          <td style={{padding:"11px 14px",fontFamily:"var(--mono)",borderBottom:"1px solid rgba(0,0,0,0.03)"}}>{timePart}</td>
                          <td style={{padding:"11px 14px",borderBottom:"1px solid rgba(0,0,0,0.03)"}}>
                            <span style={{display:"inline-flex",alignItems:"center",gap:5,fontSize:11,fontFamily:"var(--mono)",fontWeight:700,
                              padding:"3px 10px",borderRadius:20,textTransform:"uppercase",letterSpacing:".04em",
                              background:sBg[sn],color:sCls[sn]}}>{sLabels[sn]}</span>
                          </td>
                          <td style={{padding:"11px 14px",color:"var(--text)",borderBottom:"1px solid rgba(0,0,0,0.03)"}}>{row.label||sLabels[sn]}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {historyRows.length===0&&<div style={{textAlign:"center",padding:40,fontFamily:"var(--mono)",fontSize:13,color:"var(--text3)"}}>
                  <span style={{display:"block",fontSize:28,marginBottom:8,opacity:.3}}>🌙</span>No records yet — start a sleep session
                </div>}
              </div>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════
   SUB-COMPONENTS
══════════════════════════════════════ */
function Card({title,children}){
  return(
    <div style={{background:"var(--bg2)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",padding:20}}>
      <div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--text3)",letterSpacing:".08em",
        textTransform:"uppercase",marginBottom:14}}>{title}</div>
      {children}
    </div>
  );
}

function HwChip({label,val,ledClass}){
  const ledColor={on:"var(--cyan)",off:"var(--text3)",warn:"var(--amber)",danger:"var(--red)"}[ledClass]||"var(--text3)";
  const ledShadow={on:"0 0 5px var(--cyan)",warn:"0 0 5px var(--amber)",danger:"0 0 5px var(--red)"}[ledClass]||"none";
  return(
    <div style={{display:"flex",alignItems:"center",gap:6,background:"var(--bg3)",
      border:"1px solid var(--border2)",borderRadius:8,padding:"7px 12px",fontSize:12}}>
      <div style={{width:7,height:7,borderRadius:"50%",background:ledColor,boxShadow:ledShadow,flexShrink:0,
        animation:(ledClass==="warn"||ledClass==="danger")?"pulse-dot 1s infinite":"none"}}/>
      <div>
        <div style={{color:"var(--text3)",fontFamily:"var(--mono)",fontSize:10,letterSpacing:".05em",textTransform:"uppercase"}}>{label}</div>
        <div style={{color:"var(--text)",fontFamily:"var(--mono)",fontSize:12,fontWeight:700}}>{val}</div>
      </div>
    </div>
  );
}

function StepFlow({status}){
  function cls(id){
    if(status==="INFLATING"&&id==="step-a") return "active";
    if(status==="SNORE_DETECTED"){if(id==="step-a") return "done"; if(id==="step-b") return "active";}
    if(status==="SENSING"){if(id==="step-c"||id==="step-result") return "done";}
    if(status==="HAPTIC"){if(["step-a","step-b","step-c","step-result"].includes(id)) return "done"; if(id==="step-escalation") return "active";}
    if(status==="APNEA"&&id==="step-escalation") return "error";
    return "";
  }
  function nodeStyle(c){
    const base={flex:1,padding:12,borderRadius:"var(--radius)",border:"1px solid var(--border)",
      textAlign:"center",background:"var(--bg3)",transition:"all .3s"};
    if(c==="active") return{...base,borderColor:"var(--cyan)",background:"var(--cyan-dim)"};
    if(c==="done") return{...base,borderColor:"rgba(26,111,255,.25)",background:"rgba(26,111,255,.06)"};
    if(c==="error") return{...base,borderColor:"rgba(229,48,48,.25)",background:"var(--red-dim)"};
    return base;
  }
  const steps=[
    {id:"step-a",label:"Step A",val:"Signal sent"},
    {id:"step-b",label:"Step B",val:"10s window"},
    {id:"step-c",label:"Step C",val:"Re-listen"},
    {id:"step-result",label:"Result",val:status==="SENSING"?"Snore stopped":"—"},
    {id:"step-escalation",label:"Escalation",val:"Haptic"},
  ];
  return(
    <div style={{display:"flex",alignItems:"center",gap:0}}>
      {steps.map((s,i)=>(
        <>{i>0&&<span style={{color:"var(--text3)",fontSize:16,padding:"0 6px",flexShrink:0}}>→</span>}
        <div key={s.id} style={nodeStyle(cls(s.id))}>
          <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--text2)",textTransform:"uppercase",letterSpacing:".06em"}}>{s.label}</div>
          <div style={{fontFamily:"var(--mono)",fontSize:12,color:"var(--text)",marginTop:3,fontWeight:700}}>{s.val}</div>
        </div></>
      ))}
    </div>
  );
}

function PillowSVG({fsrState}){
  function fsr(id){
    const active=fsrState==="FSR_L"&&id==="fsr-l"||fsrState==="FSR_C"&&id==="fsr-c"||fsrState==="FSR_R"&&id==="fsr-r";
    return{fill:active?"url(#pg)":"transparent",stroke:active?"rgba(26,111,255,0.6)":"rgba(255,255,255,0.1)",strokeDasharray:active?undefined:"4 3"};
  }
  return(
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:12}}>
      <svg viewBox="0 0 260 110" style={{width:"100%",maxWidth:260}}>
        <defs>
          <radialGradient id="pg" cx="50%" cy="50%">
            <stop offset="0%" stopColor="rgba(26,111,255,0.09)"/>
            <stop offset="100%" stopColor="transparent"/>
          </radialGradient>
        </defs>
        <rect x="8" y="20" width="244" height="70" rx="28" fill="rgba(255,255,255,0.03)" stroke="rgba(255,255,255,0.1)" strokeWidth="1"/>
        <circle cx="56" cy="55" r="22" {...fsr("fsr-l")} strokeWidth="1"/>
        <circle cx="130" cy="55" r="22" {...fsr("fsr-c")} strokeWidth="1.5"/>
        <circle cx="204" cy="55" r="22" {...fsr("fsr-r")} strokeWidth="1"/>
        <text x="56" y="59" textAnchor="middle" fill="rgba(255,255,255,0.3)" fontSize="10" fontFamily="Space Mono">L</text>
        <text x="130" y="59" textAnchor="middle" fill="#1a6fff" fontSize="10" fontFamily="Space Mono">C</text>
        <text x="204" y="59" textAnchor="middle" fill="rgba(255,255,255,0.3)" fontSize="10" fontFamily="Space Mono">R</text>
        <text x="130" y="102" textAnchor="middle" fill="rgba(255,255,255,0.3)" fontSize="9" fontFamily="Space Mono">— pillow —</text>
      </svg>
      <div style={{fontFamily:"var(--mono)",fontSize:12,color:"var(--cyan)",textAlign:"center"}}>
        Active: <span>{fsrState}</span>
      </div>
    </div>
  );
}

function badgeStyle(cls){
  const map={
    "badge-sensing":{background:"rgba(26,111,255,.09)",color:"var(--cyan)"},
    "badge-snore":{background:"rgba(196,125,0,.1)",color:"var(--amber)"},
    "badge-inflating":{background:"rgba(90,95,199,.1)",color:"var(--purple)"},
    "badge-haptic":{background:"rgba(229,48,48,.1)",color:"var(--red)"},
    "badge-apnea":{background:"rgba(229,48,48,.15)",color:"var(--red)",animation:"blink-badge .8s infinite"},
    "badge-awake":{background:"rgba(13,82,184,.1)",color:"var(--blue)"},
    "badge-idle":{background:"rgba(138,154,176,.12)",color:"var(--text2)"},
  };
  return{display:"inline-flex",alignItems:"center",gap:5,fontFamily:"var(--mono)",fontSize:10,fontWeight:700,
    letterSpacing:".06em",padding:"3px 9px",borderRadius:20,textTransform:"uppercase",...(map[cls]||map["badge-idle"])};
}

/* ══════════════════════════════════════
   ROOT APP
══════════════════════════════════════ */
export default function App(){
  const [page,setPage]=useState("login");
  const [authUser,setAuthUser]=useState(null);
  const [authSerial,setAuthSerial]=useState("GP-A4F2");
  const [authHistory,setAuthHistory]=useState([]);

  useEffect(()=>{injectGlobalCSS();},[]);
  window._snorShiftSetPage=setPage;

  function handleLogin(user,serial,history){
    setAuthUser(user); setAuthSerial(serial); setAuthHistory(history);
    setPage("dashboard");
  }
  function handleLogout(){
    setAuthUser(null); setPage("login");
  }

  if(page==="login") return <LoginPage onLogin={handleLogin}/>;
  if(page==="register") return <RegisterPage/>;
  if(page==="dashboard"&&authUser) return <Dashboard user={authUser} serial={authSerial} initialHistory={authHistory} onLogout={handleLogout}/>;
  return <LoginPage onLogin={handleLogin}/>;
}
