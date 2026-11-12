import React, {useEffect, useRef, useState} from 'react';
import './charts.css';
const shown = p => p.value === null ? p.reason || 'Not observed' : `${p.value.toLocaleString()} reported loads`;
const shortDate = value => new Date(value+'T00:00:00Z').toLocaleDateString('en-GB',{day:'numeric',month:'short',timeZone:'UTC'});
export default function Trend({series}) {
  const svgRef=useRef(null),[size,setSize]=useState({width:1000,height:260});
  const [selection,setSelection]=useState(null);
  useEffect(()=>{const observer=new ResizeObserver(([entry])=>setSize({width:entry.contentRect.width,height:entry.contentRect.height}));observer.observe(svgRef.current);return ()=>observer.disconnect();},[]);
  const selected=series.findIndex(p=>p.date===selection),point=series[selected];
  const width=Math.max(230,size.width),height=Math.max(170,size.height),left=38,right=20,top=16,bottom=32;
  const max=Math.max(1,...series.map(p=>p.value??0)),raw=max/4,magnitude=10**Math.floor(Math.log10(raw));
  const step=[1,2,5,10].find(n=>n>=raw/magnitude)*magnitude,ceiling=Math.ceil(max/step)*step;
  const x=i=>left+i*(width-left-right)/Math.max(1,series.length-1),y=n=>height-bottom-n/ceiling*(height-top-bottom);
  const groups=[];let segment=[];
  for(let i=0;i<series.length;i++){if(series[i].value!==null)segment.push(i);else if(segment.length){groups.push(segment);segment=[];}}
  if(segment.length)groups.push(segment);
  const ticks=Array.from({length:Math.round(ceiling/step)+1},(_,i)=>i*step);
  const labelIndices=[...new Set([0,Math.floor((series.length-1)/2),series.length-1])].filter(i=>i>=0);
  function move(index){const n=Math.max(0,Math.min(series.length-1,index));setSelection(series[n]?.date||null);}
  return <section className="trend-section">
    <div className="section-heading"><div><h2>Attention over time</h2><p>Reported route loads · daily UTC · gaps remain gaps</p></div><output className="chart-readout" aria-live="polite">{point?<><small>{shortDate(point.date)}</small><b>{shown(point)}</b></>:'Select a date to inspect'}</output></div>
    <svg ref={svgRef} className="trend" viewBox={`0 0 ${width} ${height}`} role="group" aria-label="Daily reported route loads; select a date by keyboard, touch or the date control">
      <title>Daily reported route loads. Lines join observed adjacent days only; missing and suppressed values are not zero.</title>
      {ticks.map(t=><g key={t} aria-hidden="true"><path d={`M${left} ${y(t)}H${width-right}`} stroke="var(--line)" strokeWidth="1"/><text x={left-10} y={y(t)+3} textAnchor="end" fill="var(--muted)" fontSize="10">{t.toLocaleString()}</text></g>)}
      {groups.filter(g=>g.length>1).map(g=>{const d=g.map((i,j)=>`${j?'L':'M'}${x(i)},${y(series[i].value)}`).join(' ');return <g key={g[0]} aria-hidden="true"><path d={`${d}L${x(g.at(-1))},${y(0)}L${x(g[0])},${y(0)}Z`} fill="var(--copper)" opacity=".06"/><path d={d} fill="none" stroke="var(--copper)" strokeWidth="2.5" strokeLinejoin="round"/></g>;})}
      {series.map((p,i)=><g key={p.date} role="button" tabIndex="0" aria-label={`${p.date}: ${shown(p)}`} aria-pressed={selected===i} onMouseEnter={()=>move(i)} onFocus={()=>move(i)} onClick={()=>move(i)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();move(i);}if(e.key==='ArrowRight'||e.key==='ArrowLeft'){e.preventDefault();const n=Math.max(0,Math.min(series.length-1,i+(e.key==='ArrowRight'?1:-1)));move(n);svgRef.current.querySelectorAll('[role="button"]')[n].focus();}}}>
        <rect x={Math.max(left-12,x(i)-(width-left-right)/Math.max(1,series.length-1)/2)} y={top} width={Math.min((width-left-right)/Math.max(1,series.length-1),width-right-x(i)+12)} height={height-top-bottom} fill="transparent"/>
        {selected===i&&<path d={`M${x(i)} ${top}V${y(0)}`} stroke="var(--copper)" opacity=".25"/>}
        {p.value!==null&&<circle cx={x(i)} cy={y(p.value)} r={selected===i?5:3} fill="var(--copper)" stroke="#000" strokeWidth="2"/>}
      </g>)}
      {labelIndices.map(i=><text key={i} x={x(i)} y={height-8} textAnchor={i===0?'start':i===series.length-1?'end':'middle'} fontSize="10" fill="var(--muted)">{shortDate(series[i].date)}</text>)}
    </svg>
    <div className="chart-caption"><span><i/>Observed daily counts</span><label>Inspect date <select aria-label="Inspect chart date" value={selection||''} onChange={e=>setSelection(e.target.value)}><option value="">Choose a date</option>{series.map(p=><option key={p.date} value={p.date}>{p.date}</option>)}</select></label></div>
    <details><summary>Accessible daily data table</summary><table><thead><tr><th>Date (UTC)</th><th>Reported loads</th><th>Status</th></tr></thead><tbody>{series.map(p=><tr key={p.date}><th>{p.date}</th><td>{p.value===null?'Unavailable':p.value.toLocaleString()}</td><td>{p.reason||'Observed; today may be partial'}</td></tr>)}</tbody></table></details>
  </section>;
}
