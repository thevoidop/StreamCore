"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  RotateCcw,
  RotateCw,
} from "lucide-react";
import styles from "./page.module.css";

const CHUNK_SIZE = 524288;
// const FILE_SIZE = 1164990;
const BUFFER_AHEAD = 3;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 2000;

export default function Home() {
  const playerContainerRef = useRef(null);
  const videoRef = useRef(null);
  const isSeeking = useRef(false);
  const abortRef = useRef(null);
  const controlsTimeoutRef = useRef(null);
  const fileSizeRef = useRef(null);
  const retryCountRef = useRef(0);

  const [status, setStatus] = useState("idle");
  const [isPaused, setIsPaused] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [playbackRate, setPlaybackRate] = useState(1);

  // ==========================================
  // MSE & Fetching Logic
  // ==========================================

  function getBufferedAhead(video) {
    let currentTime = video.currentTime;
    for (let i = 0; i < video.buffered.length; i++) {
      if (
        video.buffered.start(i) <= currentTime &&
        video.buffered.end(i) > currentTime
      ) {
        return video.buffered.end(i) - currentTime;
      }
    }
    return 0;
  }

  function timeToChunkIndex(currentTime, duration) {
    const ratio = currentTime / duration;
    const bytePosition = ratio * fileSizeRef.current;
    return Math.floor(bytePosition / CHUNK_SIZE);
  }

  function fetchAndAppend(chunkIndex, sb, ms) {
    if (fileSizeRef.current === null && chunkIndex !== 0) {
      setTimeout(() => fetchAndAppend(chunkIndex, sb, ms), 100);
      return;
    }

    const fileSize = fileSizeRef.current;
    const start = chunkIndex * CHUNK_SIZE;
    const end = fileSize
      ? Math.min(start + CHUNK_SIZE - 1, fileSize - 1)
      : start + CHUNK_SIZE - 1;

    if (fileSizeRef.current !== null && start >= fileSizeRef.current) {
      ms.endOfStream();
      setStatus("done");
      return;
    }

    const bufferedAhead = getBufferedAhead(videoRef.current);

    if (bufferedAhead >= BUFFER_AHEAD) {
      setTimeout(() => fetchAndAppend(chunkIndex, sb, ms), 1000);
      return;
    }

    setStatus("buffering");

    if (abortRef.current) abortRef.current.abort();
    abortRef.current = new AbortController();

    fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}`, {
      headers: { Range: `bytes=${start}-${end}` },
      signal: abortRef.current.signal,
    })
      .then((res) => {
        if (chunkIndex === 0) {
          const contentRange = res.headers.get("Content-Range");
          if (contentRange) {
            const totalSize = parseInt(contentRange.split("/")[1]);
            if (!isNaN(totalSize)) {
              fileSizeRef.current = totalSize;
            }
          } else {
            console.error("No Content-Range header received");
          }
        }
        return res.arrayBuffer();
      })
      .then((data) => {
        retryCountRef.current = 0;
        sb.appendBuffer(data);
        sb.addEventListener(
          "updateend",
          () => {
            isSeeking.current = false;
            fetchAndAppend(chunkIndex + 1, sb, ms);
          },
          { once: true },
        );
      })
      .catch((err) => {
        if (err.name === "AbortError") return;
        if (retryCountRef.current < MAX_RETRIES) {
          const delay = RETRY_BASE_DELAY * Math.pow(2, retryCountRef.current);
          console.warn(
            `Fetch failed, retrying in ${delay}ms (attempt ${retryCountRef.current + 1}/${MAX_RETRIES})`,
          );
          retryCountRef.current += 1;
          setTimeout(() => fetchAndAppend(chunkIndex, sb, ms), delay);
        } else {
          console.error("Max retries reached, giving up");
          retryCountRef.current = 0;
          setStatus("error");
        }
      });
  }

  // ==========================================
  // Player Controls & Handlers
  // ==========================================
  function formatTime(seconds) {
    if (!isFinite(seconds) || isNaN(seconds)) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  const togglePlay = useCallback((e) => {
    if (e && e.stopPropagation) e.stopPropagation();
    const video = videoRef.current;
    if (!video) return;
    video.paused ? video.play() : video.pause();
  }, []);

  function handleSeek(e) {
    videoRef.current.currentTime = parseFloat(e.target.value);
  }

  const skipBackward = useCallback((e) => {
    if (e && e.stopPropagation) e.stopPropagation();
    if (videoRef.current) {
      videoRef.current.currentTime = Math.max(
        0,
        videoRef.current.currentTime - 5,
      );
    }
  }, []);

  const skipForward = useCallback((e) => {
    if (e && e.stopPropagation) e.stopPropagation();
    if (videoRef.current) {
      videoRef.current.currentTime = Math.min(
        videoRef.current.duration || 0,
        videoRef.current.currentTime + 5,
      );
    }
  }, []);

  function toggleMute() {
    const video = videoRef.current;
    video.muted = !isMuted;
    setIsMuted(!isMuted);
    if (isMuted && volume === 0) setVolume(0.5);
  }

  function handleVolumeChange(e) {
    const val = parseFloat(e.target.value);
    setVolume(val);
    videoRef.current.volume = val;
    setIsMuted(val === 0);
  }

  function handlePlaybackRateChange() {
    const rates = [1, 1.25, 1.5, 2];
    const nextRateIndex = (rates.indexOf(playbackRate) + 1) % rates.length;
    const newRate = rates[nextRateIndex];
    setPlaybackRate(newRate);
    videoRef.current.playbackRate = newRate;
  }

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      playerContainerRef.current
        ?.requestFullscreen()
        .catch((err) => console.log(err));
    } else {
      document.exitFullscreen();
    }
  }, []);

  const handleMouseMove = () => {
    setShowControls(true);
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    controlsTimeoutRef.current = setTimeout(() => {
      if (!videoRef.current?.paused) setShowControls(false);
    }, 3000);
  };

  const handleMouseLeave = () => {
    if (!videoRef.current?.paused) setShowControls(false);
  };

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")
        return;

      switch (e.code) {
        case "Space":
        case "KeyK":
          e.preventDefault();
          togglePlay();
          break;
        case "KeyF":
          e.preventDefault();
          toggleFullscreen();
          break;
        case "KeyM":
          e.preventDefault();
          toggleMute();
          break;
        case "ArrowLeft":
          e.preventDefault();
          skipBackward();
          break;
        case "ArrowRight":
          e.preventDefault();
          skipForward();
          break;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [togglePlay, toggleFullscreen, skipBackward, skipForward, toggleMute]);

  useEffect(() => {
    const handleFullscreenChange = () =>
      setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () =>
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  // ==========================================
  // Media Source Effects
  // ==========================================

  useEffect(() => {
    const handleUnhandledRejection = (e) => {
      if (e.reason?.name === "AbortError") e.preventDefault();
    };
    window.addEventListener("unhandledrejection", handleUnhandledRejection);
    const ms = new MediaSource();
    videoRef.current.src = URL.createObjectURL(ms);

    ms.addEventListener("sourceopen", () => {
      const sb = ms.addSourceBuffer(
        'video/mp4; codecs="avc1.640028, mp4a.40.2"',
      );

      videoRef.current.addEventListener("seeking", () => {
        if (!isFinite(videoRef.current.duration)) return;
        if (ms.readyState !== "open") return;

        isSeeking.current = true;
        if (sb.updating) sb.abort();

        const newChunk = timeToChunkIndex(
          videoRef.current.currentTime,
          videoRef.current.duration,
        );

        sb.remove(
          0,
          isFinite(videoRef.current.duration)
            ? videoRef.current.duration
            : fileSizeRef.current,
        );
        sb.addEventListener(
          "updateend",
          () => {
            isSeeking.current = false;
            fetchAndAppend(newChunk, sb, ms);
          },
          { once: true },
        );
      });

      fetchAndAppend(0, sb, ms);
    });

    const video = videoRef.current;

    const handleDurationChange = () => {
      if (
        video.readyState >= 1 &&
        Number.isFinite(video.duration) &&
        video.duration > 0
      ) {
        setDuration(video.duration);
      }
    };

    video.addEventListener("progress", () => {
      if (video.buffered.length > 0) {
        setBufferedEnd(video.buffered.end(video.buffered.length - 1));
      }
    });

    video.addEventListener("play", () => {
      setIsPaused(false);
      setStatus("playing");
    });
    video.addEventListener("waiting", () => setStatus("buffering"));
    video.addEventListener("canplay", () => setStatus("ready"));
    video.addEventListener("pause", () => {
      setIsPaused(true);
      setShowControls(true);
    });
    video.addEventListener("timeupdate", () =>
      setCurrentTime(video.currentTime),
    );
    video.addEventListener("loadedmetadata", () => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        setDuration(video.duration);
      }
    });
    video.addEventListener("durationchange", handleDurationChange);

    return () => {
      window.removeEventListener(
        "unhandledrejection",
        handleUnhandledRejection,
      );
    };
  }, []);

  // ==========================================
  // Render
  // ==========================================
  return (
    <div className={styles.pageWrapper}>
      <div
        className={styles.playerContainer}
        ref={playerContainerRef}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      >
        <video
          ref={videoRef}
          onClick={togglePlay}
          className={styles.videoElement}
        />

        <div
          className={`${styles.centerControlsOverlay} ${showControls || isPaused ? "" : styles.hidden}`}
        >
          <button
            onClick={skipBackward}
            className={styles.centerActionBtn}
            title="Rewind 5s"
          >
            <RotateCcw size={28} />
          </button>

          <button
            onClick={togglePlay}
            className={`${styles.centerActionBtn} ${styles.playPauseBtn}`}
          >
            {isPaused ? (
              <Play
                fill="currentColor"
                size={40}
                style={{ marginLeft: "4px" }}
              />
            ) : (
              <Pause fill="currentColor" size={40} />
            )}
          </button>

          <button
            onClick={skipForward}
            className={styles.centerActionBtn}
            title="Skip 5s"
          >
            <RotateCw size={28} />
          </button>
        </div>

        {status === "buffering" && (
          <div className={styles.bufferingIndicator}>
            <div className={styles.spinner} />
            Buffering...
          </div>
        )}

        {status === "error" && (
          <div className={styles.bufferingIndicator}>
            ⚠ Stream error. Please refresh.
          </div>
        )}

        <div
          className={`${styles.controlsOverlay} ${showControls ? "" : styles.hidden}`}
        >
          <div className={styles.progressBarContainer}>
            <div className={styles.progressTrack}>
              <div
                className={styles.progressBuffered}
                style={{
                  width: `${duration ? (bufferedEnd / duration) * 100 : 0}%`,
                }}
              />
              <div
                className={styles.progressPlayed}
                style={{
                  width: `${duration ? (currentTime / duration) * 100 : 0}%`,
                }}
              />

              {/* --- NEW ROUND SCRUBBER HEAD --- */}
              <div
                className={styles.progressThumb}
                style={{
                  left: `${duration ? (currentTime / duration) * 100 : 0}%`,
                }}
              />

              <input
                type="range"
                min={0}
                max={duration || 0}
                step={0.1}
                value={currentTime}
                onChange={handleSeek}
                className={styles.progressInput}
              />
            </div>
          </div>

          <div className={styles.controlsRow}>
            <div className={styles.controlsLeft}>
              <button onClick={togglePlay} className={styles.controlBtn}>
                {isPaused ? (
                  <Play fill="currentColor" size={24} />
                ) : (
                  <Pause fill="currentColor" size={24} />
                )}
              </button>

              <div className={styles.volumeGroup}>
                <button onClick={toggleMute} className={styles.controlBtn}>
                  {isMuted || volume === 0 ? (
                    <VolumeX size={22} />
                  ) : (
                    <Volume2 size={22} />
                  )}
                </button>
                <div className={styles.volumeSliderContainer}>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={isMuted ? 0 : volume}
                    onChange={handleVolumeChange}
                    className={styles.volumeSlider}
                  />
                </div>
              </div>

              <div className={styles.timeDisplay}>
                {formatTime(currentTime)}
                <span className={styles.timeSeparator}>/</span>
                {formatTime(duration)}
              </div>
            </div>

            <div className={styles.controlsRight}>
              <button
                onClick={handlePlaybackRateChange}
                className={`${styles.controlBtn} ${styles.rateBtn}`}
              >
                {playbackRate}x
              </button>

              <button
                onClick={toggleFullscreen}
                className={styles.controlBtn}
                title="Fullscreen"
              >
                {isFullscreen ? <Minimize size={22} /> : <Maximize size={22} />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
