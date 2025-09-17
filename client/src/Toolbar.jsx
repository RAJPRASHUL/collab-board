import React, { useState } from 'react';
import './Toolbar.css';

function Toolbar({ roomId }) {
  const [color, setColor] = useState('#000000');
  const [width, setWidth] = useState(3);
  const [tool, setTool] = useState('pen');

  const emit = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));

  const clearBoard = () => emit('whiteboard:clear');

  const selectTool = (t) => {
    setTool(t);
    emit('whiteboard:tool', { tool: t });
  };

  const onColor = (e) => {
    const value = e.target.value;
    setColor(value);
    emit('whiteboard:color', { color: value });
  };

  const onWidth = (e) => {
    const value = Number(e.target.value);
    setWidth(value);
    emit('whiteboard:width', { width: value });
  };

  // remove addShape helper - shape buttons now select the tool
  return (
    <div className="toolbar retro-card">
      <button className="btn btn-danger" onClick={clearBoard}>Clear</button>
      <span className="room-tag">Room: {roomId}</span>

 

      <div className="tool-group">
        <span className="label">Tool:</span>
        <button className={`btn ${tool==='pen'?'btn-active':''}`} onClick={() => selectTool('pen')}>Pen</button>
        <button className={`btn ${tool==='eraser'?'btn-active':''}`} onClick={() => selectTool('eraser')}>Eraser</button>
        <button className={`btn ${tool==='select'?'btn-active':''}`} onClick={() => selectTool('select')}>Select</button>
      </div>

      <div className="tool-group">
        <span className="label">Color:</span>
        <input className="color" type="color" value={color} onChange={onColor} />
      </div>

      <div className="tool-group">
        <span className="label">Width:</span>
        <input className="range" type="range" min="1" max="30" value={width} onChange={onWidth} />
        <span className="value">{width}px</span>
      </div>

      <div className="tool-group">
        <span className="label">Shapes:</span>
        <button className={`btn ${tool==='rectangle'?'btn-active':''}`} onClick={() => selectTool('rectangle')}>▭</button>
        <button className={`btn ${tool==='circle'?'btn-active':''}`} onClick={() => selectTool('circle')}>◯</button>
        <button className={`btn ${tool==='triangle'?'btn-active':''}`} onClick={() => selectTool('triangle')}>△</button>
        <button className={`btn ${tool==='line'?'btn-active':''}`} onClick={() => selectTool('line')}>／</button>
      </div>
    </div>
  );
}

export default Toolbar;
