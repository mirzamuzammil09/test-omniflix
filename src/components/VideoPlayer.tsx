'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  Loader2, 
  Volume2, 
  VolumeX, 
  Subtitles, 
  AlertCircle, 
  Play, 
  Pause, 
  ArrowRight, 
  ArrowLeft, 
  Maximize, 
  Minimize 
} from 'lucide-react';
import { tmdb } from '@/services/tmdb';

interface VideoPlayerProps {
  tmdbId: string | number;
  type: 'movie' | 'tv';
  season?: number;
  episode?: number;
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', hi: 'Hindi', es: 'Spanish', fr: 'French', de: 'German',
  it: 'Italian', pt: 'Portuguese', ru: 'Russian', zh: 'Chinese',
  ja: 'Japanese', ar: 'Arabic', tr: 'Turkish', ko: 'Korean', ta: 'Tamil', te: 'Telugu',
};

type ActiveServer = 'server1' | 'server2';

export default function VideoPlayer({ tmdbId, type, season = 1, episode = 1 }: VideoPlayerProps) {
  const devToolsDetected = false;
  const [isLoading, setIsLoading] = useState(true);
  const [isPaused, setIsPaused] = useState(true);
  const [activeServer, setActiveServer] = useState<ActiveServer>('server1');
  const [languages, setLanguages] = useState<string[]>(['en']);
  const [dubLang, setDubLang] = useState<string>('en');
  const [startAtTime, setStartAtTime] = useState<number>(0);
  const [title, setTitle] = useState<string>('');

  // Episode list for TV shows navigation
  const [episodesList, setEpisodesList] = useState<any[]>([]);

  // Server 1 (Netfilm) state
  const [s1StreamUrl, setS1StreamUrl] = useState<string | null>(null);
  const [s1AudioVersions, setS1AudioVersions] = useState<any[]>([]);
  const [s1Subtitles, setS1Subtitles] = useState<any[]>([]);
  const [s1SelectedAudio, setS1SelectedAudio] = useState<string>('none');
  const [s1SelectedSub, setS1SelectedSub] = useState<string>('none');
  const [s1Qualities, setS1Qualities] = useState<{ label: string; url: string }[]>([]);
  const [s1SelectedQuality, setS1SelectedQuality] = useState<string>('Auto');
  const [s1Error, setS1Error] = useState<string | null>(null);
  const [s1Fetching, setS1Fetching] = useState(false);

  // Custom Controls States
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTimeState] = useState(0);
  const [bufferedTime, setBufferedTime] = useState(0);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [userActive, setUserActive] = useState(true);

  // Gesture feedbacks
  const [doubleTapFeedback, setDoubleTapFeedback] = useState<'left' | 'right' | null>(null);
  const [centerIconState, setCenterIconState] = useState<'play' | 'pause' | null>(null);

  const activeTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastTouchTimeRef = useRef<number>(0);
  const clickTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const feedbackTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const centerIconTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const currentTimeRef = useRef<number>(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);

  const s1ActiveFetchRef = useRef<string | null>(null);
  const s1VideoErrorCountRef = useRef<number>(0);
  const errorResetTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastSavedTimeRef = useRef<number>(0);
  const lastSavedProgressRef = useRef<number>(0);
  const progressLoadedRef = useRef<boolean>(false);

  // localStorage progress keys
  const getProgressKey = useCallback(() => {
    return `player_progress_${type}_${tmdbId}_${season}_${episode}`;
  }, [type, tmdbId, season, episode]);

  const saveProgressLocal = useCallback((progress: number, duration: number) => {
    if (progress <= 0 || duration <= 0) return;
    try {
      localStorage.setItem(getProgressKey(), JSON.stringify({ progress, duration, updated: Date.now() }));
    } catch (e) {
      console.warn('[Progress] Failed to save progress to localStorage', e);
    }
  }, [getProgressKey]);

  const getProgressLocal = useCallback(() => {
    try {
      const dataStr = localStorage.getItem(getProgressKey());
      if (dataStr) {
        const data = JSON.parse(dataStr);
        if (data.progress && data.duration && (data.progress / data.duration) < 0.95) {
          return data.progress;
        }
      }
    } catch (e) {
      console.warn('[Progress] Failed to read progress from localStorage', e);
    }
    return 0;
  }, [getProgressKey]);

  // Load title & TV episodes details
  useEffect(() => {
    let isMounted = true;
    if (type === 'tv') {
      tmdb.getTVDetails(tmdbId)
        .then((details) => {
          if (!isMounted) return;
          setTitle(`${details.name || details.original_name || 'TV Show'} - S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`);
        })
        .catch(() => {
          if (isMounted) setTitle(`TV Show - S${season}E${episode}`);
        });

      tmdb.getTVSeasonDetails(tmdbId, season)
        .then((seasonDetails) => {
          if (!isMounted) return;
          if (seasonDetails && seasonDetails.episodes) {
            setEpisodesList(seasonDetails.episodes);
          }
        })
        .catch((e) => console.warn('[Player] Failed to load season episodes:', e));
    } else {
      tmdb.getMovieDetails(tmdbId)
        .then((details) => {
          if (!isMounted) return;
          setTitle(details.title || details.original_title || 'Movie');
        })
        .catch(() => {
          if (isMounted) setTitle('Movie');
        });
    }

    return () => {
      isMounted = false;
    };
  }, [tmdbId, type, season, episode]);

  // Right-click prevention (Relaxed for Iframe usage)
  useEffect(() => {
    const preventContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };
    document.addEventListener('contextmenu', preventContextMenu);
    return () => {
      document.removeEventListener('contextmenu', preventContextMenu);
    };
  }, []);

  // Restore playback progress
  useEffect(() => {
    currentTimeRef.current = 0;
    lastSavedProgressRef.current = 0;
    lastSavedTimeRef.current = 0;
    progressLoadedRef.current = false;

    const savedProgress = getProgressLocal();
    if (savedProgress > 0) {
      currentTimeRef.current = savedProgress;
      setCurrentTimeState(savedProgress);
      console.log(`[Progress] Loaded saved progress: ${savedProgress}s`);
      if (videoRef.current) {
        videoRef.current.currentTime = savedProgress;
      }
    } else {
      setCurrentTimeState(0);
    }
    progressLoadedRef.current = true;
  }, [tmdbId, season, episode, getProgressLocal]);

  // Fullscreen change listener
  useEffect(() => {
    const handleFsChange = () => {
      const fsElement = document.fullscreenElement ||
        (document as any).webkitFullscreenElement ||
        (document as any).mozFullScreenElement ||
        (document as any).msFullscreenElement;
      setIsFullscreen(!!fsElement);
    };

    document.addEventListener('fullscreenchange', handleFsChange);
    document.addEventListener('webkitfullscreenchange', handleFsChange);
    document.addEventListener('mozfullscreenchange', handleFsChange);
    document.addEventListener('MSFullscreenChange', handleFsChange);

    return () => {
      document.removeEventListener('fullscreenchange', handleFsChange);
      document.removeEventListener('webkitfullscreenchange', handleFsChange);
      document.removeEventListener('mozfullscreenchange', handleFsChange);
      document.removeEventListener('MSFullscreenChange', handleFsChange);
    };
  }, []);

  // Webkit fullscreen event listeners for iOS Safari on iPhone
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleWebkitBeginFs = () => {
      setIsFullscreen(true);
    };
    const handleWebkitEndFs = () => {
      setIsFullscreen(false);
    };

    video.addEventListener('webkitbeginfullscreen', handleWebkitBeginFs);
    video.addEventListener('webkitendfullscreen', handleWebkitEndFs);

    return () => {
      video.removeEventListener('webkitbeginfullscreen', handleWebkitBeginFs);
      video.removeEventListener('webkitendfullscreen', handleWebkitEndFs);
    };
  }, [s1StreamUrl]);

  // Sync Subtitles on mode change
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const tracks = video.textTracks;

    const updateTracks = () => {
      for (let i = 0; i < tracks.length; i++) {
        const track = tracks[i];
        const subTrack = s1Subtitles.find(s => s.id === s1SelectedSub);
        if (s1SelectedSub !== 'none' && subTrack && (track.label === subTrack.label || track.language === subTrack.language)) {
          track.mode = 'showing';
        } else {
          track.mode = 'disabled';
        }
      }
    };

    updateTracks();
    tracks.addEventListener('addtrack', updateTracks);
    return () => {
      tracks.removeEventListener('addtrack', updateTracks);
    };
  }, [s1SelectedSub, s1Subtitles, s1StreamUrl]);

  const handleMouseMove = useCallback(() => {
    setUserActive(true);
    if (activeTimeoutRef.current) clearTimeout(activeTimeoutRef.current);
    activeTimeoutRef.current = setTimeout(() => {
      setUserActive(false);
    }, 3000);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const container = containerRef.current;
    const video = videoRef.current;
    if (!container) return;

    const fsElement = document.fullscreenElement ||
      (document as any).webkitFullscreenElement ||
      (document as any).mozFullScreenElement ||
      (document as any).msFullscreenElement;

    if (fsElement) {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => { });
      } else if ((document as any).webkitExitFullscreen) {
        (document as any).webkitExitFullscreen();
      } else if ((document as any).mozCancelFullScreen) {
        (document as any).mozCancelFullScreen();
      } else if ((document as any).msExitFullscreen) {
        (document as any).msExitFullscreen();
      }
    } else {
      if (container.requestFullscreen) {
        container.requestFullscreen().catch((err) => {
          console.warn("Standard fullscreen failed, trying webkit fallback on video:", err);
          if (video && (video as any).webkitEnterFullscreen) {
            try {
              (video as any).webkitEnterFullscreen();
            } catch (e) {
              console.error("webkitEnterFullscreen failed:", e);
            }
          }
        });
      } else if ((container as any).webkitRequestFullscreen) {
        try {
          (container as any).webkitRequestFullscreen();
        } catch (e) {
          if (video && (video as any).webkitEnterFullscreen) {
            (video as any).webkitEnterFullscreen();
          }
        }
      } else if (video && (video as any).webkitEnterFullscreen) {
        try {
          (video as any).webkitEnterFullscreen();
        } catch (e) {
          console.error("webkitEnterFullscreen failed:", e);
        }
      }
    }
  }, []);

  const triggerCenterIcon = (type: 'play' | 'pause') => {
    setCenterIconState(type);
    if (centerIconTimeoutRef.current) clearTimeout(centerIconTimeoutRef.current);
    centerIconTimeoutRef.current = setTimeout(() => {
      setCenterIconState(null);
    }, 500);
  };

  const showDoubleTapFeedback = (side: 'left' | 'right') => {
    setDoubleTapFeedback(side);
    if (feedbackTimeoutRef.current) clearTimeout(feedbackTimeoutRef.current);
    feedbackTimeoutRef.current = setTimeout(() => {
      setDoubleTapFeedback(null);
    }, 800);
  };

  const togglePlayPause = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().catch(() => { });
      triggerCenterIcon('play');
    } else {
      video.pause();
      triggerCenterIcon('pause');
    }
  };

  const handleVideoClickOrTap = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    const width = rect.width;
    const height = rect.height;
    const relativeX = clickX / width;

    // Ignore clicks near top controls or bottom controls areas to allow clicking dropdowns/sliders
    if (clickY <= 80 || clickY >= height - 80) {
      return;
    }

    if (e.detail === 2) {
      // Double click / Double tap
      if (clickTimeoutRef.current) {
        clearTimeout(clickTimeoutRef.current);
        clickTimeoutRef.current = null;
      }
      
      const video = videoRef.current;
      if (!video) return;

      if (relativeX < 0.35) {
        video.currentTime = Math.max(0, video.currentTime - 10);
        showDoubleTapFeedback('left');
      } else if (relativeX > 0.65) {
        video.currentTime = Math.min(video.duration || 0, video.currentTime + 10);
        showDoubleTapFeedback('right');
      } else {
        toggleFullscreen();
      }
    } else {
      // Single click / Single tap - delay to check if it's a double click
      if (clickTimeoutRef.current) clearTimeout(clickTimeoutRef.current);
      clickTimeoutRef.current = setTimeout(() => {
        setUserActive(prev => !prev);
      }, 250);
    }
  };

  const handleTouchStartGesture = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length !== 1) return;

    const touch = e.touches[0];
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = touch.clientX - rect.left;
    const clickY = touch.clientY - rect.top;
    const width = rect.width;
    const height = rect.height;
    const relativeX = clickX / width;

    // Ignore touches in control areas
    if (clickY <= 80 || clickY >= height - 80) {
      return;
    }

    const now = Date.now();
    const delay = now - lastTouchTimeRef.current;
    lastTouchTimeRef.current = now;

    if (delay < 300) {
      e.preventDefault();
      if (clickTimeoutRef.current) {
        clearTimeout(clickTimeoutRef.current);
        clickTimeoutRef.current = null;
      }

      const video = videoRef.current;
      if (!video) return;

      if (relativeX < 0.35) {
        video.currentTime = Math.max(0, video.currentTime - 10);
        showDoubleTapFeedback('left');
      } else if (relativeX > 0.65) {
        video.currentTime = Math.min(video.duration || 0, video.currentTime + 10);
        showDoubleTapFeedback('right');
      } else {
        toggleFullscreen();
      }
    } else {
      if (clickTimeoutRef.current) clearTimeout(clickTimeoutRef.current);
      clickTimeoutRef.current = setTimeout(() => {
        setUserActive(prev => !prev);
      }, 250);
    }
  };

  // Keyboard Shortcuts
  const handleKeyDown = useCallback((e: KeyboardEvent | React.KeyboardEvent) => {
    if (activeServer !== 'server1') return;

    if ((e as any)._alreadyHandled) return;
    (e as any)._alreadyHandled = true;

    const video = videoRef.current;
    if (!video) return;

    switch (e.key.toLowerCase()) {
      case ' ':
      case 'k':
        e.preventDefault();
        togglePlayPause();
        break;
      case 'arrowleft':
        e.preventDefault();
        video.currentTime = Math.max(0, video.currentTime - 5);
        showDoubleTapFeedback('left');
        break;
      case 'arrowright':
        e.preventDefault();
        video.currentTime = Math.min(video.duration || 0, video.currentTime + 5);
        showDoubleTapFeedback('right');
        break;
      case 'j':
        e.preventDefault();
        video.currentTime = Math.max(0, video.currentTime - 10);
        showDoubleTapFeedback('left');
        break;
      case 'l':
        e.preventDefault();
        video.currentTime = Math.min(video.duration || 0, video.currentTime + 10);
        showDoubleTapFeedback('right');
        break;
      case 'arrowup':
        e.preventDefault();
        const nextVolUp = Math.min(1, video.volume + 0.05);
        video.volume = nextVolUp;
        setVolume(nextVolUp);
        setIsMuted(false);
        break;
      case 'arrowdown':
        e.preventDefault();
        const nextVolDown = Math.max(0, video.volume - 0.05);
        video.volume = nextVolDown;
        setVolume(nextVolDown);
        setIsMuted(nextVolDown === 0);
        break;
      case 'f':
        e.preventDefault();
        toggleFullscreen();
        break;
      case 'm':
        e.preventDefault();
        const nextMute = !video.muted;
        video.muted = nextMute;
        setIsMuted(nextMute);
        break;
      case 'c':
        e.preventDefault();
        if (s1Subtitles.length > 0) {
          if (s1SelectedSub === 'none') {
            setS1SelectedSub(s1Subtitles[0].id);
          } else {
            setS1SelectedSub('none');
          }
        }
        break;
      default:
        break;
    }
  }, [activeServer, s1Subtitles, s1SelectedSub, toggleFullscreen]);

  useEffect(() => {
    if (activeServer !== 'server1') return;
    const globalKeyHandler = (e: KeyboardEvent) => handleKeyDown(e);
    window.addEventListener('keydown', globalKeyHandler);
    return () => window.removeEventListener('keydown', globalKeyHandler);
  }, [handleKeyDown, activeServer]);

  // Load preferred server
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('iframe_preferred_server');
      if (saved === 'server2') setActiveServer('server2');
    }
  }, []);

  // Fetch translations for Server 2 (Peachify) dub
  useEffect(() => {
    if (!tmdbId || activeServer !== 'server2') return;
    let isMounted = true;
    tmdb.getTranslations(type, tmdbId)
      .then((res) => {
        if (!isMounted) return;
        const fetchedLangs = (res.translations || [])
          .map((t) => t.iso_639_1)
          .filter((iso): iso is string => iso in LANGUAGE_NAMES);
        setLanguages(Array.from(new Set(['en', ...fetchedLangs])));
      })
      .catch(() => setLanguages(['en', 'hi', 'es', 'fr', 'de']));
    return () => { isMounted = false; };
  }, [tmdbId, type, activeServer]);

  // Server 1 Fetch Scraper
  const fetchS1Stream = useCallback(async (subjectId?: string, detailPath?: string, forceRefresh?: boolean) => {
    if (devToolsDetected) return;
    const fetchKey = `${tmdbId}_${season}_${episode}_${subjectId || 'none'}_${forceRefresh || 'false'}`;
    if (s1ActiveFetchRef.current === fetchKey) return;
    s1ActiveFetchRef.current = fetchKey;

    setIsLoading(true);
    setS1Error(null);

    if (!subjectId) {
      setS1StreamUrl(null);
      setS1AudioVersions([]);
      setS1Subtitles([]);
      setS1SelectedAudio('none');
      setS1SelectedSub('none');
    } else {
      setS1StreamUrl(null);
    }

    let success = false;
    let lastError: any = null;

    try {
      const res = await fetch('/api/playback', {
        method: 'POST',
        headers: {
          'Cache-Control': 'no-cache',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          id: String(tmdbId),
          type,
          season,
          episode,
          server: 'source_06',
          subjectId,
          detailPath,
          forceRefresh,
          timestamp: Date.now(),
        }),
      });

      const data = await res.json();

      if (s1ActiveFetchRef.current !== fetchKey) return;

      if (!res.ok) {
        if (data?.dubFailed && Array.isArray(data.audioVersions)) {
          setS1AudioVersions(data.audioVersions);
        }
        throw new Error(data.error || 'Proxy request failed');
      }

      if (data.streamUrl) {
        setS1StreamUrl(data.streamUrl);
        if (data.subtitles?.length > 0) setS1Subtitles(data.subtitles);
        if (data.audioVersions?.length > 0) setS1AudioVersions(data.audioVersions);
        if (subjectId) setS1SelectedAudio(subjectId);

        if (data.qualities?.length > 0) {
          setS1Qualities(data.qualities);
          const activeQ = data.qualities.find((q: any) => q.url === data.streamUrl) || data.qualities[0];
          setS1SelectedQuality(activeQ?.label || 'Auto');
        } else {
          setS1Qualities([]);
          setS1SelectedQuality('Auto');
        }
        setS1SelectedSub('none');
        success = true;
        setTimeout(() => videoRef.current?.play().catch(() => { }), 300);
      } else {
        throw new Error('No stream URL in response');
      }
    } catch (err: any) {
      lastError = err;
    }

    if (s1ActiveFetchRef.current !== fetchKey) return;

    if (!success) {
      const errorMsg = lastError?.message || 'Stream fetch failed';
      setS1StreamUrl(null);
      setS1Error(errorMsg);
      setIsLoading(false);
      if (subjectId) setS1SelectedAudio('none');
    }
    setS1Fetching(false);
    s1ActiveFetchRef.current = null;
  }, [tmdbId, type, season, episode]);

  // Reset Server 1 state synchronously on content change during render phase
  const [lastId, setLastId] = useState<string | number>(tmdbId);
  const [lastSeason, setLastSeason] = useState<number>(season);
  const [lastEpisode, setLastEpisode] = useState<number>(episode);

  if (tmdbId !== lastId || season !== lastSeason || episode !== lastEpisode) {
    setLastId(tmdbId);
    setLastSeason(season);
    setLastEpisode(episode);
    setS1StreamUrl(null);
    setS1AudioVersions([]);
    setS1Subtitles([]);
    setS1SelectedAudio('none');
    setS1SelectedSub('none');
    setS1Qualities([]);
    setS1SelectedQuality('Auto');
    setS1Error(null);
    setS1Fetching(false);
    setIsLoading(true);
    s1VideoErrorCountRef.current = 0;
    s1ActiveFetchRef.current = null;
    setCurrentTimeState(0);
    setDuration(0);
    setBufferedTime(0);
  }

  // Trigger load on Server 1
  useEffect(() => {
    if (devToolsDetected) return;
    if (activeServer === 'server1') {
      fetchS1Stream();
    }
  }, [activeServer, tmdbId, season, episode, fetchS1Stream, devToolsDetected]);

  const handleAudioChange = (subjectId: string) => {
    if (videoRef.current) {
      currentTimeRef.current = videoRef.current.currentTime;
    }

    setS1SelectedAudio(subjectId);

    if (subjectId === 'none') {
      fetchS1Stream();
    } else {
      const track = s1AudioVersions.find((t) => t.subject_id === subjectId || t.id === subjectId);
      if (track) {
        const sid = track.subject_id || track.id;
        const dpath = track.detail_path || track.path || '';
        fetchS1Stream(sid, dpath);
      } else {
        fetchS1Stream(subjectId, '');
      }
    }
  };

  const handleSubtitleChange = (subId: string) => {
    setS1SelectedSub(subId);
  };

  const handleQualityChange = (label: string) => {
    if (videoRef.current) {
      currentTimeRef.current = videoRef.current.currentTime;
    }
    const q = s1Qualities.find((item) => item.label === label);
    if (q) {
      setS1SelectedQuality(label);
      setS1StreamUrl(q.url);
    }
  };

  // TV Navigation helpers
  const handlePrevEpisode = () => {
    if (episode > 1) {
      window.location.href = `/tv/${tmdbId}/${season}/${episode - 1}`;
    }
  };

  const handleNextEpisode = () => {
    if (episodesList.length > 0) {
      const hasNext = episodesList.some(ep => ep.episode_number === episode + 1);
      if (hasNext) {
        window.location.href = `/tv/${tmdbId}/${season}/${episode + 1}`;
      } else {
        window.location.href = `/tv/${tmdbId}/${season + 1}/1`;
      }
    } else {
      window.location.href = `/tv/${tmdbId}/${season}/${episode + 1}`;
    }
  };

  const hasNextEpisode = () => {
    if (episodesList.length > 0) {
      return episodesList.some(ep => ep.episode_number === episode + 1) || season < 100;
    }
    return true;
  };

  // Time & Scrubbing management
  const handleTimeUpdate = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const video = e.currentTarget;
    if (!isScrubbing) {
      setCurrentTimeState(video.currentTime);
    }
    
    if (video.buffered.length > 0) {
      let maxBuffered = 0;
      for (let i = 0; i < video.buffered.length; i++) {
        if (video.buffered.start(i) <= video.currentTime && video.buffered.end(i) >= video.currentTime) {
          maxBuffered = video.buffered.end(i);
          break;
        }
      }
      if (maxBuffered === 0 && video.buffered.length > 0) {
        maxBuffered = video.buffered.end(video.buffered.length - 1);
      }
      setBufferedTime(maxBuffered);
    }

    // Save progress local state
    if (video.currentTime > 0) {
      const time = video.currentTime;
      const durationVal = video.duration;
      const timeDiff = Math.abs(time - lastSavedProgressRef.current);
      const now = Date.now();
      if (now - lastSavedTimeRef.current > 10000 || timeDiff > 5) {
        lastSavedTimeRef.current = now;
        lastSavedProgressRef.current = time;
        saveProgressLocal(time, durationVal);
      }
    }
  };

  const handleDurationChange = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    setDuration(e.currentTarget.duration || 0);
  };

  // Timeline Interaction
  const handleTimelineInteraction = useCallback((clientX: number) => {
    const timeline = timelineRef.current;
    const video = videoRef.current;
    if (!timeline || !video || !duration) return;

    const rect = timeline.getBoundingClientRect();
    const pos = (clientX - rect.left) / rect.width;
    const boundedPos = Math.max(0, Math.min(1, pos));
    const targetTime = boundedPos * duration;
    
    setCurrentTimeState(targetTime);
  }, [duration]);

  const handleMouseDown = (e: React.MouseEvent) => {
    setIsScrubbing(true);
    handleTimelineInteraction(e.clientX);
  };

  const handleTouchStartScrub = (e: React.TouchEvent) => {
    setIsScrubbing(true);
    if (e.touches.length > 0) {
      handleTimelineInteraction(e.touches[0].clientX);
    }
  };

  useEffect(() => {
    if (!isScrubbing) return;

    let lastSeekTime = 0;
    const handleMove = (clientX: number) => {
      const timeline = timelineRef.current;
      const video = videoRef.current;
      if (!timeline || !video || !duration) return;

      const rect = timeline.getBoundingClientRect();
      const pos = (clientX - rect.left) / rect.width;
      const boundedPos = Math.max(0, Math.min(1, pos));
      const targetTime = boundedPos * duration;
      setCurrentTimeState(targetTime);
      
      const now = Date.now();
      if (now - lastSeekTime > 100) {
        video.currentTime = targetTime;
        lastSeekTime = now;
      }
    };

    const onMouseMove = (e: MouseEvent) => {
      handleMove(e.clientX);
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length > 0) {
        handleMove(e.touches[0].clientX);
      }
    };

    const onMouseUp = (e: MouseEvent) => {
      setIsScrubbing(false);
      const video = videoRef.current;
      if (video && duration) {
        const timeline = timelineRef.current;
        if (timeline) {
          const rect = timeline.getBoundingClientRect();
          const pos = (e.clientX - rect.left) / rect.width;
          const boundedPos = Math.max(0, Math.min(1, pos));
          video.currentTime = boundedPos * duration;
        }
      }
    };

    const onTouchEnd = () => {
      setIsScrubbing(false);
      const video = videoRef.current;
      if (video && duration) {
        video.currentTime = currentTime;
      }
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('touchmove', onTouchMove);
    window.addEventListener('touchend', onTouchEnd);

    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
    };
  }, [isScrubbing, duration, currentTime]);

  const handleVolumeChange = (newVolume: number) => {
    setVolume(newVolume);
    const video = videoRef.current;
    if (video) {
      video.volume = newVolume;
      video.muted = newVolume === 0;
      setIsMuted(newVolume === 0);
    }
  };

  const formatTime = (timeInSeconds: number) => {
    if (isNaN(timeInSeconds)) return '0:00';
    const hours = Math.floor(timeInSeconds / 3600);
    const minutes = Math.floor((timeInSeconds % 3600) / 60);
    const seconds = Math.floor(timeInSeconds % 60);

    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  };

  const setVideoRef = useCallback((node: HTMLVideoElement | null) => {
    videoRef.current = node;
  }, []);

  if (devToolsDetected) {
    return <div className="absolute inset-0 bg-black z-50" />;
  }

  return (
    <div
      ref={containerRef}
      onMouseMove={handleMouseMove}
      onTouchMove={handleMouseMove}
      className="relative w-full h-full bg-black overflow-hidden select-none group/player flex items-center justify-center"
      style={{ cursor: userActive ? 'default' : 'none' }}
    >
      {/* ─── Premium Glass Floating Top Controls Bar ─── */}
      <div
        className={`absolute top-2 left-2 right-2 sm:top-4 sm:left-4 sm:right-4 z-30 flex flex-wrap items-center justify-between gap-2 sm:gap-3 p-2 sm:p-3 rounded-2xl glass-panel border border-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.6)] transition-all duration-300 ${userActive || isPaused ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-4 pointer-events-none'
          }`}
        onMouseEnter={() => {
          if (activeTimeoutRef.current) clearTimeout(activeTimeoutRef.current);
        }}
        onMouseLeave={handleMouseMove}
      >
        <div className="flex items-center gap-2 sm:gap-3">
          <span className="text-[10px] sm:text-xs font-bold text-white truncate max-w-[180px] sm:max-w-[400px]">
            {title || 'Loading title...'}
          </span>
        </div>

        {/* Server indicator / Title indicator */}
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-black text-red-500 bg-red-950/40 border border-red-500/20 px-2 py-0.5 rounded-md uppercase tracking-widest animate-pulse-glow">
            Server 1
          </span>
        </div>
      </div>

      {/* ─── Loading / Error Overlay ─── */}
      {((isLoading || (s1Fetching && !s1StreamUrl) || s1Error)) && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-neutral-950/95 backdrop-blur-md">
          <span className="text-[10px] font-black tracking-[0.25em] text-red-500 uppercase mb-2 animate-pulse-glow">
            Premium Video Player
          </span>
          {s1Error ? (
            <div className="flex flex-col items-center gap-3 p-4 text-center max-w-sm">
              <AlertCircle className="w-10 h-10 text-red-500 mb-1 drop-shadow-[0_0_10px_rgba(239,68,68,0.4)] animate-pulse" />
              <span className="text-xs font-bold text-neutral-300 uppercase tracking-wider">
                Playback Error
              </span>
              <p className="text-[10px] text-neutral-400 normal-case mb-2 leading-relaxed">
                {s1Error}
              </p>
              <div className="flex gap-2.5 w-full justify-center">
                <button
                  onClick={() => { fetchS1Stream(); }}
                  className="px-4 py-2 bg-red-600 hover:bg-red-700 active:scale-95 text-white text-[10px] font-black tracking-wider uppercase rounded-xl transition-all shadow-[0_0_12px_rgba(220,38,38,0.25)]"
                >
                  Retry Loading
                </button>
              </div>
            </div>
          ) : (
            <>
              <Loader2 className="w-10 h-10 text-red-600 animate-spin mb-3 drop-shadow-[0_0_12px_rgba(229,9,20,0.6)]" />
              <span className="text-xs font-bold text-neutral-300 tracking-widest uppercase animate-pulse">
                Connecting to Server…
              </span>
            </>
          )}
        </div>
      )}

      {/* ─── HTML5 Player Container & Video Element ─── */}
      {s1StreamUrl && !s1Error && (
        <div className="absolute inset-0 w-full h-full flex items-center justify-center">
          <video
            ref={setVideoRef}
            key={s1StreamUrl}
            src={s1StreamUrl}
            controlsList="nodownload noremoteplayback"
            onContextMenu={(e) => e.preventDefault()}
            autoPlay
            className={`w-full h-full object-contain bg-black transition-opacity duration-700 focus:outline-none ${isLoading ? 'opacity-0' : 'opacity-100'}`}
            onTimeUpdate={handleTimeUpdate}
            onDurationChange={handleDurationChange}
            onPlay={(e) => {
              setIsPaused(false);
              setIsMuted(e.currentTarget.muted || e.currentTarget.volume === 0);
            }}
            onPause={(e) => {
              setIsPaused(true);
              const time = e.currentTarget.currentTime;
              const durationVal = e.currentTarget.duration;
              if (time > 0) {
                saveProgressLocal(time, durationVal);
              }
            }}
            onVolumeChange={(e) => {
              setIsMuted(e.currentTarget.muted || e.currentTarget.volume === 0);
            }}
            onPlaying={() => {
              setIsLoading(false);
            }}
            onWaiting={(e) => {
              if (e.currentTarget.currentTime === 0) {
                setIsLoading(true);
              }
            }}
            onCanPlay={(e) => {
              setIsLoading(false);
              if (errorResetTimeoutRef.current) clearTimeout(errorResetTimeoutRef.current);
              errorResetTimeoutRef.current = setTimeout(() => {
                s1VideoErrorCountRef.current = 0;
              }, 30000);

              const video = e.currentTarget;
              if (video.paused) {
                video.play().catch((err) => {
                  console.warn("[Autoplay] Autoplay with audio was blocked, trying muted...", err);
                  video.muted = true;
                  setIsMuted(true);
                  video.play().catch(() => { });
                });
              } else {
                setIsMuted(video.muted || video.volume === 0);
              }
            }}
            onLoadedMetadata={() => {
              if (videoRef.current && currentTimeRef.current > 0) {
                videoRef.current.currentTime = currentTimeRef.current;
              }
            }}
            onError={(e) => {
              if (errorResetTimeoutRef.current) {
                clearTimeout(errorResetTimeoutRef.current);
                errorResetTimeoutRef.current = null;
              }
              const video = e.currentTarget;
              const errorCode = video.error?.code;

              if (video.currentTime > 0) {
                currentTimeRef.current = video.currentTime;
              }

              if (s1VideoErrorCountRef.current < 3) {
                s1VideoErrorCountRef.current += 1;
                console.warn(`[Player] Video error code=${errorCode}, auto-refetch attempt ${s1VideoErrorCountRef.current}/3`);
                setS1StreamUrl(null);
                setIsLoading(true);

                const shouldForceRefresh = s1VideoErrorCountRef.current > 1;
                setTimeout(() => {
                  fetchS1Stream(
                    s1SelectedAudio !== 'none' ? s1SelectedAudio : undefined,
                    s1AudioVersions.find((t: any) => t.subject_id === s1SelectedAudio || t.id === s1SelectedAudio)?.detail_path,
                    shouldForceRefresh
                  );
                }, 1500);
              } else {
                setS1Error('Stream failed to load after multiple retries. Please try switching to Server 2.');
              }
            }}
          >
            {s1Subtitles.map((sub) => (
              <track
                key={sub.id}
                src={`/api/subtitles?url=${encodeURIComponent(sub.url)}`}
                kind="subtitles"
                srcLang={sub.language}
                label={sub.label}
                default={sub.language === 'en' || sub.language?.startsWith('en') || s1SelectedSub === sub.id}
              />
            ))}
          </video>

          {/* Interactive Event Overlay (Handles clicks/taps for controls and gestures) */}
          <div
            onClick={handleVideoClickOrTap}
            onTouchStart={handleTouchStartGesture}
            className="absolute inset-0 z-10 cursor-pointer"
          />
        </div>
      )}

      {/* ─── Double Tap / Play Pause Center Overlays ─── */}
      <div className="absolute inset-0 pointer-events-none z-20 flex items-center justify-center">
        {/* Left Seek Feedback */}
        {doubleTapFeedback === 'left' && (
          <div className="absolute left-1/4 flex flex-col items-center justify-center bg-black/60 rounded-full w-20 h-20 animate-double-tap border border-white/10">
            <ArrowLeft className="w-8 h-8 text-white mb-1 animate-pulse" />
            <span className="text-[10px] font-black text-white">-10s</span>
          </div>
        )}

        {/* Right Seek Feedback */}
        {doubleTapFeedback === 'right' && (
          <div className="absolute right-1/4 flex flex-col items-center justify-center bg-black/60 rounded-full w-20 h-20 animate-double-tap border border-white/10">
            <ArrowRight className="w-8 h-8 text-white mb-1 animate-pulse" />
            <span className="text-[10px] font-black text-white">+10s</span>
          </div>
        )}

        {/* Center Play/Pause Transition Indicator */}
        {centerIconState && (
          <div className="flex items-center justify-center bg-black/50 backdrop-blur-sm rounded-full w-20 h-20 border border-white/10 scale-100 opacity-100 transition-all duration-300 animate-ping-once">
            {centerIconState === 'play' ? (
              <Play className="w-10 h-10 text-white fill-current" />
            ) : (
              <Pause className="w-10 h-10 text-white fill-current" />
            )}
          </div>
        )}
      </div>

      {/* ─── Custom Premium Glass Bottom Controls Bar ─── */}
      {s1StreamUrl && !s1Error && (
        <div
          className={`absolute bottom-2 left-2 right-2 sm:bottom-4 sm:left-4 sm:right-4 z-30 flex flex-col p-3 rounded-2xl glass-panel border border-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.6)] transition-all duration-300 ${userActive || isPaused || isScrubbing ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4 pointer-events-none'
            }`}
          onMouseEnter={() => {
            if (activeTimeoutRef.current) clearTimeout(activeTimeoutRef.current);
          }}
          onMouseLeave={handleMouseMove}
        >
          {/* Timeline Scrubber Container */}
          <div 
            ref={timelineRef}
            onMouseDown={handleMouseDown}
            onTouchStart={handleTouchStartScrub}
            className="relative w-full h-4 flex items-center cursor-pointer group/timeline mb-2"
          >
            {/* Progress rail background */}
            <div className="h-1 w-full bg-white/20 rounded-full relative group-hover/timeline:h-1.5 transition-all duration-200">
              {/* Buffered progress */}
              <div 
                className="absolute top-0 bottom-0 left-0 bg-white/30 rounded-full transition-all duration-100"
                style={{ width: `${duration ? (bufferedTime / duration) * 100 : 0}%` }}
              />
              {/* Current progress */}
              <div 
                className="absolute top-0 bottom-0 left-0 bg-red-600 rounded-full"
                style={{ width: `${duration ? (currentTime / duration) * 100 : 0}%` }}
              />
              {/* Glow effect at the end of progress */}
              <div 
                className="absolute top-0 bottom-0 bg-red-400 blur-[2px]"
                style={{ 
                  left: `0px`, 
                  width: `${duration ? (currentTime / duration) * 100 : 0}%` 
                }}
              />
            </div>
            {/* Timeline Handle / Thumb */}
            <div 
              className="absolute w-3.5 h-3.5 bg-red-500 rounded-full shadow-[0_0_10px_rgba(239,68,68,0.8)] border-2 border-white scale-100 sm:scale-0 sm:group-hover/timeline:scale-100 focus:scale-100 active:scale-110 transition-transform duration-150 -translate-y-1/2 top-1/2"
              style={{ 
                left: `${duration ? (currentTime / duration) * 100 : 0}%`,
                marginLeft: '-7px'
              }}
            />
          </div>

          {/* Controls Row */}
          <div className="flex flex-wrap items-center justify-between gap-y-2 gap-x-3">
            {/* Left Controls Group */}
            <div className="flex items-center gap-3">
              {/* Play/Pause Button */}
              <button
                onClick={togglePlayPause}
                className="p-1.5 text-white hover:text-red-500 hover:scale-110 active:scale-95 transition-all cursor-pointer rounded-lg hover:bg-white/5"
                aria-label={isPaused ? "Play" : "Pause"}
              >
                {isPaused ? <Play className="w-5 h-5 fill-current" /> : <Pause className="w-5 h-5 fill-current" />}
              </button>

              {/* Skip Back 10s */}
              <button
                onClick={() => {
                  const video = videoRef.current;
                  if (video) {
                    video.currentTime = Math.max(0, video.currentTime - 10);
                    showDoubleTapFeedback('left');
                  }
                }}
                className="p-1.5 text-white hover:text-red-500 hover:scale-110 active:scale-95 transition-all cursor-pointer rounded-lg hover:bg-white/5 hidden sm:inline-flex"
                aria-label="Skip backward 10s"
              >
                <ArrowLeft className="w-4 h-4" />
                <span className="text-[10px] font-bold ml-0.5">10s</span>
              </button>

              {/* Skip Forward 10s */}
              <button
                onClick={() => {
                  const video = videoRef.current;
                  if (video) {
                    video.currentTime = Math.min(video.duration || 0, video.currentTime + 10);
                    showDoubleTapFeedback('right');
                  }
                }}
                className="p-1.5 text-white hover:text-red-500 hover:scale-110 active:scale-95 transition-all cursor-pointer rounded-lg hover:bg-white/5 hidden sm:inline-flex"
                aria-label="Skip forward 10s"
              >
                <span className="text-[10px] font-bold mr-0.5">10s</span>
                <ArrowRight className="w-4 h-4" />
              </button>

              {/* TV Navigation: Previous Episode & Next Episode */}
              {type === 'tv' && (
                <div className="flex items-center gap-1">
                  {episode > 1 && (
                    <button
                      onClick={handlePrevEpisode}
                      className="p-1.5 text-white hover:text-red-500 hover:scale-110 active:scale-95 transition-all cursor-pointer rounded-lg hover:bg-white/5 flex items-center gap-1"
                      title="Previous Episode"
                    >
                      <ArrowLeft className="w-4 h-4" />
                      <span className="text-[9px] font-black uppercase tracking-wider hidden md:inline">Prev Ep</span>
                    </button>
                  )}
                  {hasNextEpisode() && (
                    <button
                      onClick={handleNextEpisode}
                      className="p-1.5 text-white hover:text-red-500 hover:scale-110 active:scale-95 transition-all cursor-pointer rounded-lg hover:bg-white/5 flex items-center gap-1"
                      title="Next Episode"
                    >
                      <span className="text-[9px] font-black uppercase tracking-wider hidden md:inline">Next Ep</span>
                      <ArrowRight className="w-4 h-4" />
                    </button>
                  )}
                </div>
              )}

              {/* Volume Control Group */}
              <div className="flex items-center gap-1.5 group/volume">
                <button
                  onClick={() => {
                    const video = videoRef.current;
                    if (video) {
                      const newMuteState = !video.muted;
                      video.muted = newMuteState;
                      setIsMuted(newMuteState);
                    }
                  }}
                  className="p-1.5 text-white hover:text-red-500 hover:scale-110 active:scale-95 transition-all cursor-pointer rounded-lg hover:bg-white/5"
                  aria-label={isMuted ? "Unmute" : "Mute"}
                >
                  {isMuted ? <VolumeX className="w-4.5 h-4.5 text-neutral-400" /> : <Volume2 className="w-4.5 h-4.5" />}
                </button>
                {/* Desktop volume slider */}
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={isMuted ? 0 : volume}
                  onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
                  className="w-0 group-hover/volume:w-16 focus:w-16 h-1 bg-white/20 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:bg-red-600 [&::-webkit-slider-thumb]:rounded-full transition-all duration-300 outline-none hidden sm:block"
                />
              </div>

              {/* Time Code Display */}
              <div className="text-[11px] font-semibold text-neutral-300 tracking-wider">
                {formatTime(currentTime)} <span className="text-neutral-500 mx-0.5">/</span> {formatTime(duration)}
              </div>
            </div>

            {/* Right Controls Group */}
            <div className="flex items-center gap-2">
              {/* Dub selector */}
              {s1AudioVersions.length > 0 && (
                <div className="flex items-center gap-1">
                  <select
                    value={s1SelectedAudio}
                    onChange={(e) => handleAudioChange(e.target.value)}
                    disabled={s1Fetching && s1AudioVersions.length === 0}
                    className="px-1.5 py-0.5 sm:px-2 sm:py-1 bg-neutral-950/80 hover:bg-neutral-900 border border-white/10 rounded-xl text-[9px] sm:text-[10px] font-bold uppercase tracking-wider text-neutral-300 hover:text-white cursor-pointer focus:outline-none focus:ring-1 focus:ring-red-600 disabled:opacity-40"
                  >
                    <option value="none">Original</option>
                    {s1AudioVersions.map((track) => (
                      <option key={track.subject_id || track.id} value={track.subject_id || track.id}>
                        {track.label || track.language || 'Dub'}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Subtitle Selector */}
              {s1Subtitles.length > 0 && (
                <div className="flex items-center gap-1">
                  <select
                    value={s1SelectedSub}
                    onChange={(e) => handleSubtitleChange(e.target.value)}
                    className="px-1.5 py-0.5 sm:px-2 sm:py-1 bg-neutral-950/80 hover:bg-neutral-900 border border-white/10 rounded-xl text-[9px] sm:text-[10px] font-bold uppercase tracking-wider text-neutral-300 hover:text-white cursor-pointer focus:outline-none focus:ring-1 focus:ring-red-600"
                  >
                    <option value="none">Subtitles Off</option>
                    {s1Subtitles.map((sub) => (
                      <option key={sub.id} value={sub.id}>
                        {sub.label || sub.language || 'Subtitle'}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Quality Selector */}
              {s1Qualities.length > 0 && (
                <div className="flex items-center gap-1">
                  <select
                    value={s1SelectedQuality}
                    onChange={(e) => handleQualityChange(e.target.value)}
                    className="px-1.5 py-0.5 sm:px-2 sm:py-1 bg-neutral-950/80 hover:bg-neutral-900 border border-white/10 rounded-xl text-[9px] sm:text-[10px] font-bold uppercase tracking-wider text-neutral-300 hover:text-white cursor-pointer focus:outline-none focus:ring-1 focus:ring-red-600"
                  >
                    {s1Qualities.map((q) => (
                      <option key={q.label} value={q.label}>
                        {q.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Fullscreen Button */}
              <button
                onClick={toggleFullscreen}
                className="p-1.5 text-white hover:text-red-500 hover:scale-110 active:scale-95 transition-all cursor-pointer rounded-lg hover:bg-white/5"
                aria-label={isFullscreen ? "Exit Fullscreen" : "Enter Fullscreen"}
              >
                {isFullscreen ? <Minimize className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
