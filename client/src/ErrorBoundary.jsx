import React from 'react';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error) {
    // Update state so the next render will show the fallback UI
    return { hasError: true };
  }

  componentDidCatch(error, errorInfo) {
    // Log the error to console for debugging
    console.error('ErrorBoundary caught an error:', error, errorInfo);
    
    this.setState({
      error: error,
      errorInfo: errorInfo
    });
  }

  render() {
    if (this.state.hasError) {
      // Fallback UI
      return (
        <div style={{ 
          padding: '20px', 
          border: '1px solid #ff6b6b', 
          borderRadius: '8px', 
          backgroundColor: '#ffe0e0',
          margin: '20px'
        }}>
          <h2 style={{ color: '#d63031' }}>Something went wrong with the Whiteboard</h2>
          <details style={{ whiteSpace: 'pre-wrap', marginTop: '10px' }}>
            <summary>Error Details (click to expand)</summary>
            <div style={{ marginTop: '10px', fontSize: '12px', fontFamily: 'monospace' }}>
              <strong>Error:</strong> {this.state.error && this.state.error.toString()}
              <br />
              <strong>Stack Trace:</strong>
              <pre>{this.state.errorInfo.componentStack}</pre>
            </div>
          </details>
          <button 
            onClick={() => window.location.reload()} 
            style={{ 
              marginTop: '15px', 
              padding: '8px 16px', 
              backgroundColor: '#0984e3', 
              color: 'white', 
              border: 'none', 
              borderRadius: '4px',
              cursor: 'pointer'
            }}
          >
            Reload Page
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;