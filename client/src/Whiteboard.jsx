import React, { useEffect, useRef, useState } from "react";
import * as fabric from "fabric";
import "./Whiteboard.css";

function Whiteboard({ roomId }) {
  const canvasContainerRef = useRef(null);
  const fabricRef = useRef(null);
  const wsRef = useRef(null);
  const [brushColor, setBrushColor] = useState("#000000");
  const [brushWidth, setBrushWidth] = useState(3);
  const [currentTool, setCurrentTool] = useState("pen");
  const objectIdCounter = useRef(0);
  const historyRef = useRef({
    states: [],
    currentStateIndex: -1,
  });

  const SERVER_HOST = import.meta.env.VITE_SERVER_HOST || "127.0.0.1:8000";

  // ADD THIS FUNCTION:
  const generateObjectId = () => {
    return `obj_${Date.now()}_${objectIdCounter.current++}`;
  };

  // Save current state to history
  const saveState = () => {
    const canvas = fabricRef.current;
    if (!canvas) return;

    const history = historyRef.current;
    const json = JSON.stringify(canvas.toJSON(['customId']));

    // If we're not at the end of the history, remove all future states
    if (history.currentStateIndex < history.states.length - 1) {
      history.states = history.states.slice(0, history.currentStateIndex + 1);
    }

    history.states.push(json);
    history.currentStateIndex++;

    // Keep only the last 50 states to prevent memory issues
    if (history.states.length > 50) {
      history.states.shift();
      history.currentStateIndex--;
    }
  };

  // Handle undo operation
  const handleUndo = () => {
    const canvas = fabricRef.current;
    const history = historyRef.current;
    if (!canvas || history.currentStateIndex <= 0) return;

    history.currentStateIndex--;
    const previousState = JSON.parse(history.states[history.currentStateIndex]);
    
    canvas.clear();
    canvas.loadFromJSON(previousState, () => {
      canvas.renderAll();
      // Broadcast the undo action
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'undo' }));
      }
    });
  };

  // Handle redo operation
  const handleRedo = () => {
    const canvas = fabricRef.current;
    const history = historyRef.current;
    if (!canvas || history.currentStateIndex >= history.states.length - 1) return;

    history.currentStateIndex++;
    const nextState = JSON.parse(history.states[history.currentStateIndex]);
    
    canvas.clear();
    canvas.loadFromJSON(nextState, () => {
      canvas.renderAll();
      // Broadcast the redo action
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'redo' }));
      }
    });
  };

  // Main useEffect for initializing canvas and WebSocket
  // Main useEffect for initializing canvas and WebSocket
  useEffect(() => {
    const containerEl = canvasContainerRef.current;
    if (!containerEl) return;

    containerEl.innerHTML = "";
    const canvasEl = document.createElement("canvas");
    containerEl.appendChild(canvasEl);

    const canvas = new fabric.Canvas(canvasEl, {
      backgroundColor: "#ffffff",
      isDrawingMode: true,
      preserveObjectStacking: true,
      selection: false,
    });
    fabricRef.current = canvas;

    const setCanvasSize = () => {
      if (containerEl) {
        const { width, height } = containerEl.getBoundingClientRect();
        canvas.setWidth(width);
        canvas.setHeight(height);
        canvas.renderAll();
      }
    };

    setCanvasSize();
    window.addEventListener("resize", setCanvasSize);

    if (!canvas.freeDrawingBrush) {
      canvas.freeDrawingBrush = new fabric.PencilBrush(canvas);
    }
    console.log("✅ Canvas initialized successfully");

    // --- COLLABORATION FIX 1: SIMPLIFIED RECEIVING LOGIC ---
    const applyRemoteAction = (msg) => {
      console.log("Applying remote action:", msg.type, msg);
      if (!canvas || !msg || !msg.type || !msg.payload) return;

      if (msg.type === "path") {
        try {
          console.log("Creating path from payload");
          const customId = msg.payload.customId || generateObjectId();
          const pathObj = new fabric.Path(msg.payload.path, {
            ...msg.payload,
            selectable: false,
            evented: false,
            customId: customId,
          });
          pathObj.customId = customId;
          canvas.add(pathObj);
          canvas.renderAll();
          console.log("Remote path added successfully");
        } catch (error) {
          console.error("Error creating path:", error);
        }
      } else if (msg.type === "shape") {
        try {
          console.log("Creating shape from payload, type:", msg.payload.type);
          let obj = null;

          // Convert to lowercase for comparison
          const shapeType = msg.payload.type.toLowerCase();

          if (shapeType === "rect") {
            obj = new fabric.Rect(msg.payload);
          } else if (shapeType === "circle") {
            obj = new fabric.Circle(msg.payload);
          } else if (shapeType === "triangle") {
            obj = new fabric.Triangle(msg.payload);
          } else if (shapeType === "line") {
            obj = new fabric.Line(
              [msg.payload.x1, msg.payload.y1, msg.payload.x2, msg.payload.y2],
              msg.payload
            );
          } else {
            console.log("Unknown shape type, trying enlivenObjects");
            fabric.util.enlivenObjects([msg.payload], (objects) => {
              if (objects.length > 0) {
                const obj = objects[0];
                obj.selectable = false;
                obj.evented = false;
                // ADD THIS LINE:
                const customId = msg.payload.customId || generateObjectId();
                obj.set("customId", customId);
                obj.customId = customId;
                canvas.add(obj);
                canvas.renderAll();
                console.log("Remote shape added via enlivenObjects");
              }
            });
            return;
          }

          if (obj) {
            obj.selectable = false;
            obj.evented = false;
            // MOVE BEFORE canvas.add AND ADD TO OBJECT PROPERTIES:
            const customId = msg.payload.customId || generateObjectId();
            obj.set("customId", customId);
            obj.customId = customId; // Also set as direct property
            canvas.add(obj);
            canvas.renderAll();
            console.log("Remote shape added successfully with ID:", customId);
          } else {
            console.log("Failed to create shape object");
          }
        } catch (error) {
          console.error("Error creating shape:", error, msg.payload);
        }
      } else if (msg.type === "object:modified") {
        try {
          console.log("Applying object modification:", msg.payload);

          const targetObject = canvas
            .getObjects()
            .find((obj) => obj.customId === msg.payload.objectId);

          if (targetObject) {
            const wasEvented = targetObject.evented;
            targetObject.evented = false;

            targetObject.set(msg.payload.modifications);
            targetObject.setCoords();

            targetObject.evented = wasEvented;

            canvas.renderAll();
            console.log(
              "Object modification applied successfully for ID:",
              msg.payload.objectId
            );
          } else {
            console.log("Could not find object with ID:", msg.payload.objectId);
          }
        } catch (error) {
          console.error("Error applying object modification:", error);
        }
      } else if (msg.type === "clear") {
        console.log("Clearing canvas from remote");
        canvas.clear();
        canvas.backgroundColor = "#ffffff";
        canvas.renderAll();
      }
    };

    const connect = () => {
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      const host = SERVER_HOST;
      const wsUrl = `${protocol}://${host}/ws/${roomId}`;
      console.log("🔌 Connecting to WebSocket:", wsUrl);
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log("✅ WebSocket connected, readyState:", ws.readyState);
      };

      ws.onmessage = (event) => {
        console.log("📨 Received WebSocket message:", event.data);
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "history" && Array.isArray(msg.payload)) {
            console.log("📚 Applying history:", msg.payload.length, "items");
            msg.payload.forEach(applyRemoteAction);
          } else {
            applyRemoteAction(msg);
          }
        } catch (err) {
          console.error("❌ Invalid WS message:", err);
        }
      };

      ws.onerror = (err) => console.error("❌ WebSocket error:", err);
      ws.onclose = () => console.log("🔌 WebSocket closed");
    };

    connect();

    const onPathCreated = (e) => {
      console.log("🎨 Path created event fired:", e.path);
      if (!e.path) return;
      e.path.selectable = false;
      e.path.evented = false;
      e.path.customId = generateObjectId();

      const pathData = e.path.toObject();
      pathData.customId = e.path.customId;

      const message = { type: "path", payload: pathData };
      console.log("📤 Sending path message:", JSON.stringify(message));

      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify(message));
        console.log("✅ Path message sent successfully");
        // Save state after adding a path
        saveState();
      } else {
        console.log(
          "❌ WebSocket not ready, readyState:",
          wsRef.current?.readyState
        );
      }
    };
    canvas.on("path:created", onPathCreated);

    // ADD THESE LINES HERE:
    const onObjectModified = (e) => {
      console.log("Object modified:", e.target);
      console.log(
        "DEBUG: Target customId:",
        e.target.customId,
        "Type:",
        e.target.type
      );

      let targetObject = e.target;

      if (e.target.type === "activeSelection") {
        const objects = e.target.getObjects();
        if (objects.length === 1) {
          targetObject = objects[0];
          console.log(
            "DEBUG: Using object from activeSelection, ID:",
            targetObject.customId
          );
        } else {
          console.log("Multiple objects selected, skipping modification sync");
          return;
        }
      }

      if (!targetObject || !targetObject.customId) {
        console.log("DEBUG: No customId found, skipping");
        return;
      }

      const modifications = {
        left: targetObject.left,
        top: targetObject.top,
        scaleX: targetObject.scaleX,
        scaleY: targetObject.scaleY,
        angle: targetObject.angle,
        flipX: targetObject.flipX,
        flipY: targetObject.flipY,
      };

      const message = {
        type: "object:modified",
        payload: {
          objectId: targetObject.customId,
          modifications: modifications,
        },
      };

      console.log("Sending object modification:", JSON.stringify(message));

      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify(message));
        console.log("Object modification sent successfully");
      }
    };
    canvas.on("object:modified", onObjectModified);

    return () => {
      window.removeEventListener("resize", setCanvasSize);
      wsRef.current?.close(1000, "Component unmounting");
      if (fabricRef.current) {
        fabricRef.current.off("object:modified", onObjectModified);
        fabricRef.current.dispose();
        fabricRef.current = null;
      }
    };
  }, [roomId]);

  // Effect for handling tool changes
  useEffect(() => {
    const canvas = fabricRef.current;
    if (!canvas) return;

    const isPenTool = currentTool === "pen" || currentTool === "eraser";
    canvas.isDrawingMode = isPenTool;

    if (isPenTool) {
      canvas.selection = false;
      canvas.skipTargetFind = true;
      const brush = canvas.freeDrawingBrush;
      if (brush) {
        brush.color = currentTool === "eraser" ? "#ffffff" : brushColor;
        brush.width = currentTool === "eraser" ? brushWidth * 2 : brushWidth;
      }
    } else if (currentTool === "select") {
      canvas.selection = true;
      canvas.skipTargetFind = false;
      canvas.defaultCursor = "default";

      // Enable interaction with all objects
      canvas.forEachObject((obj) => {
        obj.selectable = true;
        obj.evented = true;
      });

      canvas.renderAll();
    } else {
      canvas.selection = false;
      canvas.skipTargetFind = true;
    }
  }, [currentTool, brushColor, brushWidth]);

  // Effect for handling shape drawing
  useEffect(() => {
    const canvas = fabricRef.current;
    if (!canvas) return;

    const isShapeTool = ["rectangle", "circle", "triangle", "line"].includes(
      currentTool
    );
    if (!isShapeTool) return;

    let isDrawing = false,
      startPoint = {},
      shape = null;

    const handleMouseDown = (opt) => {
      startPoint = canvas.getPointer(opt.e);
      const commonOptions = {
        left: startPoint.x,
        top: startPoint.y,
        stroke: brushColor,
        strokeWidth: brushWidth,
        fill: "transparent",
        selectable: false,
        evented: false,
      };
      switch (currentTool) {
        case "rectangle":
          shape = new fabric.Rect({ ...commonOptions, width: 0, height: 0 });
          break;
        case "circle":
          shape = new fabric.Circle({
            ...commonOptions,
            radius: 0,
            originX: "center",
            originY: "center",
          });
          break;
        case "triangle":
          shape = new fabric.Triangle({
            ...commonOptions,
            width: 0,
            height: 0,
          });
          break;
        case "line":
          shape = new fabric.Line(
            [startPoint.x, startPoint.y, startPoint.x, startPoint.y],
            commonOptions
          );
          break;
        default:
          return;
      }
      isDrawing = true;
      canvas.add(shape);
    };

    const handleMouseMove = (opt) => {
      if (!isDrawing || !shape) return;
      const pointer = canvas.getPointer(opt.e);
      switch (currentTool) {
        case "rectangle":
        case "triangle":
          shape.set({
            width: Math.abs(pointer.x - startPoint.x),
            height: Math.abs(pointer.y - startPoint.y),
            left: Math.min(pointer.x, startPoint.x),
            top: Math.min(pointer.y, startPoint.y),
          });
          break;
        case "circle":
          const radius =
            Math.sqrt(
              Math.pow(pointer.x - startPoint.x, 2) +
                Math.pow(pointer.y - startPoint.y, 2)
            ) / 2;
          shape.set({
            radius,
            left: (pointer.x + startPoint.x) / 2,
            top: (pointer.y + startPoint.y) / 2,
          });
          break;
        case "line":
          shape.set({ x2: pointer.x, y2: pointer.y });
          break;
        default:
          break;
      }
      canvas.renderAll();
    };

    const handleMouseUp = () => {
      console.log("🔺 Shape completed:", currentTool);
      if (!isDrawing || !shape) return;
      shape.set({ selectable: true, evented: true });

      // ADD THESE LINES:
      shape.customId = generateObjectId();

      const shapeData = shape.toObject();
      shapeData.customId = shape.customId;

      console.log("Shape object type:", shape.type, "ID:", shape.customId);

      const message = { type: "shape", payload: shapeData };
      console.log("📤 Sending shape message:", JSON.stringify(message));

      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify(message));
        console.log("✅ Shape message sent successfully");
      } else {
        console.log(
          "❌ WebSocket not ready for shape, readyState:",
          wsRef.current?.readyState
        );
      }

      isDrawing = false;
      shape = null;
    };

    canvas.on("mouse:down", handleMouseDown);
    canvas.on("mouse:move", handleMouseMove);
    canvas.on("mouse:up", handleMouseUp);

    return () => {
      canvas.off("mouse:down", handleMouseDown);
      canvas.off("mouse:move", handleMouseMove);
      canvas.off("mouse:up", handleMouseUp);
    };
  }, [currentTool, brushColor, brushWidth]);

  // Effect for your external UI events
  // Effect for your external UI events
  useEffect(() => {
    const onTool = (e) => e.detail?.tool && setCurrentTool(e.detail.tool);
    const onColor = (e) => e.detail?.color && setBrushColor(e.detail.color);
    const onWidth = (e) =>
      e.detail?.width && setBrushWidth(Number(e.detail.width));

    // Add clear button handler
    const onClear = () => {
      console.log("Clear button clicked");
      const canvas = fabricRef.current;
      if (canvas) {
        // Clear local canvas
        canvas.clear();
        canvas.backgroundColor = "#ffffff";
        canvas.renderAll();

        // Send clear message to other clients
        const message = { type: "clear" };
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify(message));
          console.log("Clear message sent successfully");
        }
      }
    };

    window.addEventListener("whiteboard:tool", onTool);
    window.addEventListener("whiteboard:color", onColor);
    window.addEventListener("whiteboard:width", onWidth);
    window.addEventListener("whiteboard:clear", onClear);

    return () => {
      window.removeEventListener("whiteboard:tool", onTool);
      window.removeEventListener("whiteboard:color", onColor);
      window.removeEventListener("whiteboard:width", onWidth);
      window.removeEventListener("whiteboard:undo", onUndo);
      window.removeEventListener("whiteboard:redo", onRedo);
      window.removeEventListener("whiteboard:clear", onClear);
    };
  }, []);

  return (
      <div
      className="whiteboard-wrap"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        padding: "0.5rem",
        boxSizing: "border-box",
      }}
    >
      {/* Your actual toolbar component can be re-integrated here */}
      <div
        className="toolbar-placeholder"
        style={{ flexShrink: 0, height: "50px" }}
      >      </div>

      <div
        className="canvas-frame"
        style={{ flexGrow: 1, position: "relative" }}
      >
        <div
          ref={canvasContainerRef}
          className="canvas-container"
          style={{ width: "100%", height: "100%" }}
        />
      </div>
    </div>
  );
}

export default Whiteboard;
