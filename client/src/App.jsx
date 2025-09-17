import { useState, useEffect } from "react";
import Whiteboard from "./Whiteboard";
import Toolbar from "./Toolbar";
import ErrorBoundary from "./ErrorBoundary";
import "./RetroTitle.css";
import "./RainbowBorder.css";
import "./ShareRoom.css";

function App() {
  const [roomId, setRoomId] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    // Check if room ID is provided in URL
    const urlParams = new URLSearchParams(window.location.search);
    const urlRoomId = urlParams.get('room');
    
    if (urlRoomId) {
      // Join existing room from URL
      console.log("Joining existing room:", urlRoomId);
      setRoomId(urlRoomId);
      setError(null);
    } else {
      // Create a new room
      const initRoom = async () => {
        const SERVER_HTTP = import.meta.env.VITE_SERVER_HTTP || "http://127.0.0.1:8000";
        try {
          const res = await fetch(`${SERVER_HTTP}/rooms`, { method: "POST" });
          if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to create room`);
          const data = await res.json();
          setRoomId(data.room_id);
          setError(null);
          
          // Update URL with room ID (without page reload)
          const newUrl = `${window.location.origin}${window.location.pathname}?room=${data.room_id}`;
          window.history.replaceState({}, '', newUrl);
        } catch (e) {
          console.error("Primary room creation failed:", e.message);
          // fallback to legacy endpoint if server is old
          try {
            const res = await fetch(`${SERVER_HTTP}/create-room`);
            if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to create room (legacy)`);
            const data = await res.json();
            setRoomId(data.room_id);
            setError(null);
            
            // Update URL with room ID
            const newUrl = `${window.location.origin}${window.location.pathname}?room=${data.room_id}`;
            window.history.replaceState({}, '', newUrl);
          } catch (err) {
            console.error("Fallback room creation failed:", err.message);
            setError("Failed to create room. Is the backend running on port 8000?");
          }
        }
      };
      initRoom();
    }
  }, []);

  const handleRetry = () => {
    setError(null);
    setRoomId(null);
    // Trigger useEffect to run again
    window.location.reload();
  };

  if (error) {
    return (
      <div style={{ padding: '20px', textAlign: 'center' }}>
        <h2 style={{ color: "red" }}>Connection Error</h2>
        <p>{error}</p>
        <p>Please ensure the backend server is running on port 8000.</p>
        <button 
          onClick={handleRetry}
          style={{ 
            padding: '10px 20px', 
            backgroundColor: '#0984e3', 
            color: 'white', 
            border: 'none', 
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '16px'
          }}
        >
          Retry Connection
        </button>
      </div>
    );
  }

  if (!roomId) {
    return (
      <div style={{ padding: '20px', textAlign: 'center' }}>
        <h2>Loading Room...</h2>
        <p>Creating a new whiteboard session...</p>
      </div>
    );
  }

  const shareableUrl = roomId ? `${window.location.origin}${window.location.pathname}?room=${roomId}` : '';

  const copyToClipboard = () => {
    if (shareableUrl) {
      navigator.clipboard.writeText(shareableUrl).then(() => {
        alert('Room URL copied to clipboard!');
      }).catch(() => {
        // Fallback for older browsers
        const textArea = document.createElement('textarea');
        textArea.value = shareableUrl;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
        alert('Room URL copied to clipboard!');
      });
    }
  };

  return (
    <div className="retro-app">
      {roomId && (
        <div style={{
          position: 'absolute',
          top: '20px',
          left: '20px',
          zIndex: 1000,
          background: 'radial-gradient(circle at center, rgba(0,0,17,0.95) 0%, rgba(0,0,17,1) 100%)'
        }}>
                {roomId && (
        <div className="share-box">
          <h2>SHARE THIS ROOM</h2>
          <div className="input-container">
            <input 
              type="text" 
              value={shareableUrl} 
              className="input-box"
              readOnly 
            />
            <button className="copy-btn" onClick={copyToClipboard}>COPY</button>
          </div>
        </div>
      )}
        </div>
      )}
      <div className="app-header">
        <div className="rainbow-border">
          <h1 className="retro-title">WHITEBOARD</h1>
        </div>
      </div>
      
      <ErrorBoundary>
        <Toolbar roomId={roomId} />
        <Whiteboard roomId={roomId} />
      </ErrorBoundary>
    </div>
  );
}

export default App;