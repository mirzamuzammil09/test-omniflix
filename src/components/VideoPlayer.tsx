'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Loader2, Server, Volume2, Subtitles, AlertCircle, Play, Pause, Settings, Globe, ArrowRight, ArrowLeft, Maximize, Minimize } from 'lucide-react';
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
  const [devToolsDetected, setDevToolsDetected] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    const threshold = 160;
    const widthDiff = window.outerWidth - window.innerWidth;
    const heightDiff = window.outerHeight - window.innerHeight;
    if (
      (widthDiff > threshold || heightDiff > threshold) &&
      window.innerWidth > 400 && window.innerHeight > 400
    ) {
      return true;
    }
    return false;
  });
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
  const [s1DownloadFilename, setS1DownloadFilename] = useState<string>('video.mp4');
  const [isMuted, setIsMuted] = useState(false);

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [userActive, setUserActive] = useState(true);
  const activeTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastTouchTimeRef = useRef<number>(0);
  const currentTimeRef = useRef<number>(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

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

  // DevTools and Scraper prevention system
  useEffect(() => {
    // 1. Disable right click
    const preventContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };
    document.addEventListener('contextmenu', preventContextMenu);

    // 2. Disable keyboard shortcut commands for DevTools
    const preventKeys = (e: KeyboardEvent) => {
      // F12 key
      if (e.key === 'F12') {
        e.preventDefault();
        return false;
      }
      // Ctrl+Shift+I, Ctrl+Shift+J, Ctrl+Shift+C, Ctrl+U
      if (
        (e.ctrlKey || e.metaKey) &&
        (e.shiftKey && (e.key === 'I' || e.key === 'i' || e.key === 'J' || e.key === 'j' || e.key === 'C' || e.key === 'c') ||
          e.key === 'U' || e.key === 'u' || e.key === 'S' || e.key === 's')
      ) {
        e.preventDefault();
        return false;
      }
    };
    document.addEventListener('keydown', preventKeys);

    // 3. Timing-based debugger detection
    const detect = () => {
      const start = performance.now();
      debugger;
      const end = performance.now();
      if (end - start > 50) {
        setDevToolsDetected(true);
        setS1StreamUrl(null);
        return true;
      }
      return false;
    };

    // 4. Viewport size-based detection
    const detectBySize = () => {
      const threshold = 160;
      const widthDiff = window.outerWidth - window.innerWidth;
      const heightDiff = window.outerHeight - window.innerHeight;
      if (
        (widthDiff > threshold || heightDiff > threshold) &&
        window.innerWidth > 400 && window.innerHeight > 400
      ) {
        setDevToolsDetected(true);
        setS1StreamUrl(null);
        return true;
      }
      return false;
    };

    const checkInterval = setInterval(() => {
      if (detect() || detectBySize()) {
        clearInterval(checkInterval);
      }
    }, 500);

    return () => {
      document.removeEventListener('contextmenu', preventContextMenu);
      document.removeEventListener('keydown', preventKeys);
      clearInterval(checkInterval);
    };
  }, []);

  // Redirect to YouTube in a new tab and close/clear the current tab when DevTools is detected
  useEffect(() => {
    if (devToolsDetected) {
      const targetUrl = 'https://youtu.be/jy4qYmf3TxA?si=Nu7WAz9owc1dPnfo';
      try {
        const opened = window.open(targetUrl, '_blank');
        if (!opened) {
          // Popup blocker intercepted, fallback to redirecting current tab
          window.location.replace(targetUrl);
          return;
        }
      } catch (e) {
        window.location.replace(targetUrl);
        return;
      }
      try {
        window.open('', '_self');
        window.close();
      } catch (e) { }
      // Fallback: clear the current page to about:blank so they can't inspect the player
      window.location.replace('about:blank');
    }
  }, [devToolsDetected]);

  // Restore playback progress
  useEffect(() => {
    currentTimeRef.current = 0;
    lastSavedProgressRef.current = 0;
    lastSavedTimeRef.current = 0;
    progressLoadedRef.current = false;

    const savedProgress = getProgressLocal();
    if (savedProgress > 0) {
      currentTimeRef.current = savedProgress;
      console.log(`[Progress] Loaded saved progress: ${savedProgress}s`);
      if (videoRef.current) {
        videoRef.current.currentTime = savedProgress;
      }
    }
    progressLoadedRef.current = true;
  }, [tmdbId, season, episode, getProgressLocal]);

  // Fullscreen change listener and redirection guard
  useEffect(() => {
    const handleFsChange = () => {
      const fsElement = document.fullscreenElement ||
        (document as any).webkitFullscreenElement ||
        (document as any).mozFullScreenElement ||
        (document as any).msFullscreenElement;

      // Fallback: If the video element itself went fullscreen directly, exit it and request container instead.
      if (fsElement && videoRef.current && fsElement === videoRef.current) {
        const container = containerRef.current;
        if (container) {
          if (document.exitFullscreen) {
            document.exitFullscreen().then(() => {
              const requestFS = container.requestFullscreen ||
                                (container as any).webkitRequestFullscreen ||
                                (container as any).mozRequestFullScreen ||
                                (container as any).msRequestFullscreen;
              if (requestFS) {
                requestFS.call(container).catch(() => {});
              }
            }).catch(() => {});
          } else if ((document as any).webkitExitFullscreen) {
            (document as any).webkitExitFullscreen();
            const requestFS = container.requestFullscreen ||
                              (container as any).webkitRequestFullscreen;
            if (requestFS) {
              requestFS.call(container);
            }
          }
          return;
        }
      }

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

  // Intercept all native video player fullscreen requests (e.g. from Brave native controls bar button)
  useEffect(() => {
    const video = videoRef.current;
    const container = containerRef.current;
    if (!video || !container) return;

    // Save the original video fullscreen functions
    const originalRequestFullscreen = video.requestFullscreen;
    const originalWebkitRequestFullscreen = (video as any).webkitRequestFullscreen;
    const originalWebkitEnterFullscreen = (video as any).webkitEnterFullscreen;

    // Intercept native video element fullscreen calls and redirect to the parent container
    const interceptFullscreen = function(this: HTMLVideoElement, options?: any) {
      console.log('Intercepted native fullscreen request on video, redirecting to containerRef');
      const requestFS = container.requestFullscreen || 
                        (container as any).webkitRequestFullscreen || 
                        (container as any).mozRequestFullScreen || 
                        (container as any).msRequestFullscreen;
      if (requestFS) {
        return requestFS.call(container, options);
      }
      return Promise.reject(new Error('Fullscreen not supported on container'));
    };

    // Override the video element methods directly
    (video as any).requestFullscreen = interceptFullscreen;
    (video as any).webkitRequestFullscreen = interceptFullscreen;
    (video as any).webkitEnterFullscreen = interceptFullscreen;

    // Intercept iOS / webkitbeginfullscreen events
    const handleWebKitEnterFullscreen = (e: Event) => {
      e.preventDefault();
      const requestFS = container.requestFullscreen || 
                        (container as any).webkitRequestFullscreen || 
                        (container as any).mozRequestFullScreen || 
                        (container as any).msRequestFullscreen;
      if (requestFS) {
        requestFS.call(container);
      }
    };
    video.addEventListener('webkitbeginfullscreen', handleWebKitEnterFullscreen);
    video.addEventListener('webkitenterfullscreen', handleWebKitEnterFullscreen);

    return () => {
      // Restore original functions if video unmounts or changes
      if (video) {
        (video as any).requestFullscreen = originalRequestFullscreen;
        (video as any).webkitRequestFullscreen = originalWebkitRequestFullscreen;
        (video as any).webkitEnterFullscreen = originalWebkitEnterFullscreen;
        video.removeEventListener('webkitbeginfullscreen', handleWebKitEnterFullscreen);
        video.removeEventListener('webkitenterfullscreen', handleWebKitEnterFullscreen);
      }
    };
  }, [s1StreamUrl]);

  const handleMouseMove = useCallback(() => {
    setUserActive(true);
    if (activeTimeoutRef.current) clearTimeout(activeTimeoutRef.current);
    activeTimeoutRef.current = setTimeout(() => {
      setUserActive(false);
    }, 3000);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const container = containerRef.current;
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
      }
    } else {
      if (container.requestFullscreen) {
        container.requestFullscreen().catch(() => { });
      } else if ((container as any).webkitRequestFullscreen) {
        (container as any).webkitRequestFullscreen();
      }
    }
  }, []);

  const handleVideoTouchStart = (e: React.TouchEvent<HTMLVideoElement>) => {
    const video = videoRef.current;
    if (!video) return;

    if (e.touches.length === 1) {
      const touch = e.touches[0];
      const rect = video.getBoundingClientRect();
      const clickX = touch.clientX - rect.left;
      const clickY = touch.clientY - rect.top;
      const width = rect.width;
      const height = rect.height;
      const relativeX = clickX / width;

      // Ignore touches near the bottom controls/top menu areas
      if (clickY >= height - 80 || clickY <= 80) {
        return;
      }

      const now = Date.now();
      const prevTouchTime = lastTouchTimeRef.current;
      lastTouchTimeRef.current = now;

      const delay = now - prevTouchTime;
      if (delay < 300) {
        // Double tap: seek 10s back or forward
        if (relativeX < 0.35) {
          e.preventDefault();
          video.currentTime = Math.max(0, video.currentTime - 10);
        } else if (relativeX > 0.65) {
          e.preventDefault();
          video.currentTime = Math.min(video.duration || 0, video.currentTime + 10);
        }
      }
    }
  };

  const handleNativeVideoClick = useCallback((e: MouseEvent) => {
    const video = videoRef.current;
    if (!video) return;

    const rect = video.getBoundingClientRect();
    const clickY = e.clientY - rect.top;
    const height = rect.height;

    // Ignore clicks on controls area
    if (clickY >= height - 80) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    // Toggle play/pause
    if (video.paused) {
      video.play().catch(() => { });
    } else {
      video.pause();
    }
  }, []);

  const handleNativeVideoDblClick = useCallback((e: MouseEvent) => {
    const video = videoRef.current;
    if (!video) return;

    const rect = video.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    const width = rect.width;
    const height = rect.height;
    const relativeX = clickX / width;

    if (clickY >= height - 80) return;

    e.preventDefault();
    e.stopPropagation();

    if (relativeX < 0.4) {
      video.currentTime = Math.max(0, video.currentTime - 10);
    } else if (relativeX > 0.6) {
      video.currentTime = Math.min(video.duration || 0, video.currentTime + 10);
    } else {
      toggleFullscreen();
    }
  }, [toggleFullscreen]);

  const setVideoRef = useCallback((node: HTMLVideoElement | null) => {
    if (videoRef.current) {
      videoRef.current.removeEventListener('click', handleNativeVideoClick, { capture: true });
      videoRef.current.removeEventListener('dblclick', handleNativeVideoDblClick, { capture: true });
    }
    videoRef.current = node;
    if (node) {
      node.addEventListener('click', handleNativeVideoClick, { capture: true });
      node.addEventListener('dblclick', handleNativeVideoDblClick, { capture: true });
    }
  }, [handleNativeVideoClick, handleNativeVideoDblClick]);

  // Keyboard Shortcuts
  const handleKeyDown = useCallback((e: KeyboardEvent | React.KeyboardEvent) => {
    if (activeServer !== 'server1') return;

    if ((e as any)._alreadyHandled) return;
    (e as any)._alreadyHandled = true;

    const video = videoRef.current;
    if (!video) return;

    switch (e.key.toLowerCase()) {
      case ' ':
        e.preventDefault();
        if (video.paused) {
          video.play().catch(() => { });
        } else {
          video.pause();
        }
        break;
      case 'k':
        e.preventDefault();
        if (video.paused) {
          video.play().catch(() => { });
        } else {
          video.pause();
        }
        break;
      case 'arrowleft':
        e.preventDefault();
        video.currentTime = Math.max(0, video.currentTime - 5);
        break;
      case 'arrowright':
        e.preventDefault();
        video.currentTime = Math.min(video.duration || 0, video.currentTime + 5);
        break;
      case 'j':
        e.preventDefault();
        video.currentTime = Math.max(0, video.currentTime - 10);
        break;
      case 'l':
        e.preventDefault();
        video.currentTime = Math.min(video.duration || 0, video.currentTime + 10);
        break;
      case 'arrowup':
        e.preventDefault();
        video.volume = Math.min(1, video.volume + 0.05);
        break;
      case 'arrowdown':
        e.preventDefault();
        video.volume = Math.max(0, video.volume - 0.05);
        break;
      case 'f':
        e.preventDefault();
        toggleFullscreen();
        break;
      case 'm':
        e.preventDefault();
        video.muted = !video.muted;
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

    setS1Fetching(true);
    setS1Error(null);
    setIsLoading(true);

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

      // Guard against race conditions from older navigation triggers
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

    // Guard against race conditions from older navigation triggers
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
  }

  // Trigger load on Server 1
  useEffect(() => {
    if (devToolsDetected) return;
    if (activeServer === 'server1') {
      fetchS1Stream();
    }
  }, [activeServer, tmdbId, season, episode, fetchS1Stream, devToolsDetected]);

  const handleServerChange = (server: ActiveServer) => {
    setActiveServer(server);
    if (typeof window !== 'undefined') {
      localStorage.setItem('iframe_preferred_server', server);
    }
  };

  const handleLanguageChange = (newLang: string) => {
    if (newLang === dubLang) return;
    if (videoRef.current) {
      setStartAtTime(Math.floor(videoRef.current.currentTime));
    }
    setDubLang(newLang);
    setIsLoading(true);
  };

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

  // Peachify (Server 2) embed link
  const startAtQuery = startAtTime > 0 ? `&startAt=${startAtTime}` : '';
  const peachifyUrl = type === 'movie'
    ? `https://peachify.pro/embed/movie/${tmdbId}?dub=${dubLang}${startAtQuery}`
    : `https://peachify.pro/embed/tv/${tmdbId}/${season}/${episode}?dub=${dubLang}${startAtQuery}`;

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
        // Try season + 1 episode 1
        window.location.href = `/tv/${tmdbId}/${season + 1}/1`;
      }
    } else {
      // Fallback
      window.location.href = `/tv/${tmdbId}/${season}/${episode + 1}`;
    }
  };

  const hasNextEpisode = () => {
    if (episodesList.length > 0) {
      return episodesList.some(ep => ep.episode_number === episode + 1) || season < 100; // soft allow
    }
    return true;
  };

  if (devToolsDetected) {
    return <div className="absolute inset-0 bg-black z-50" />;
  }

  return (
    <div
      ref={containerRef}
      onMouseMove={handleMouseMove}
      onTouchMove={handleMouseMove}
      className="relative w-screen h-screen bg-black overflow-hidden select-none group/player"
      style={{ cursor: userActive ? 'default' : 'none' }}
    >
      {/* ─── Premium Glass Floating Top Controls Bar ─── */}
      <div
        className={`absolute top-2 left-2 right-2 sm:top-4 sm:left-4 sm:right-4 z-30 flex flex-wrap items-center justify-between gap-2 sm:gap-3 p-2 sm:p-3 rounded-2xl glass-panel border border-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.6)] transition-all duration-300 ${userActive || isPaused ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-4 pointer-events-none'
          }`}
      >
        {/* Title Details */}
        <div className="flex items-center gap-2 sm:gap-3">
          <span className="text-[10px] sm:text-xs font-bold text-white truncate max-w-[180px] sm:max-w-[400px]">
            {title || 'Loading title...'}
          </span>
        </div>

        {/* Action Dropdowns */}
        <div className="flex items-center gap-2">
          {/* Dub / Language Selector */}
          <div className="flex items-center gap-1">
            <Volume2 className="w-3.5 h-3.5 text-neutral-400" />
            <select
              value={s1SelectedAudio}
              onChange={(e) => handleAudioChange(e.target.value)}
              disabled={s1Fetching && s1AudioVersions.length === 0}
              className="px-1.5 py-1 sm:px-2.5 sm:py-1.5 bg-neutral-950/80 hover:bg-neutral-900 border border-white/10 rounded-xl text-[9px] sm:text-[10px] font-extrabold uppercase tracking-wider text-neutral-300 hover:text-white cursor-pointer focus:outline-none focus:ring-1 focus:ring-red-600 disabled:opacity-40"
            >
              <option value="none">
                {s1Fetching && s1AudioVersions.length === 0 ? 'Loading...' : s1AudioVersions.length === 0 ? 'Original' : 'Original'}
              </option>
              {s1AudioVersions.map((track) => (
                <option key={track.subject_id || track.id} value={track.subject_id || track.id}>
                  {track.label || track.language || 'Dub'}
                </option>
              ))}
            </select>
          </div>

          {/* Qualities Selector */}
          {s1Qualities.length > 0 && (
            <div className="flex items-center gap-1">
              <span className="text-[9px] sm:text-[10px] font-black text-neutral-400 uppercase mr-0.5">HD</span>
              <select
                value={s1SelectedQuality}
                onChange={(e) => handleQualityChange(e.target.value)}
                className="px-1.5 py-1 sm:px-2.5 sm:py-1.5 bg-neutral-950/80 hover:bg-neutral-900 border border-white/10 rounded-xl text-[9px] sm:text-[10px] font-extrabold uppercase tracking-wider text-neutral-300 hover:text-white cursor-pointer focus:outline-none focus:ring-1 focus:ring-red-600"
              >
                {s1Qualities.map((q) => (
                  <option key={q.label} value={q.label}>
                    {q.label}
                  </option>
                ))}
              </select>
            </div>
          )}


        </div>
      </div>

      {/* ─── Loading / Error Overlay ─── */}
      {((isLoading || (activeServer === 'server1' && s1Fetching && !s1StreamUrl) || (activeServer === 'server1' && s1Error))) && (
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

      {/* ─── Server 1 (HTML5 Native Player) ─── */}
      {activeServer === 'server1' && s1StreamUrl && !s1Fetching && !s1Error && (
        <video
          ref={setVideoRef}
          key={s1StreamUrl + s1SelectedSub}
          src={s1StreamUrl}
          controls
          controlsList="nodownload noremoteplayback"
          onContextMenu={(e) => e.preventDefault()}
          autoPlay
          onKeyDown={handleKeyDown}
          onTouchStart={handleVideoTouchStart}
          className={`absolute inset-0 w-full h-full object-contain bg-black transition-opacity duration-700 focus:outline-none ${isLoading ? 'opacity-0' : 'opacity-100'
            }`}
          onTimeUpdate={(e) => {
            const time = e.currentTarget.currentTime;
            const duration = e.currentTarget.duration;
            if (time > 0) {
              currentTimeRef.current = time;

              // Save progress to localStorage every 10 seconds or on significant jumps
              const timeDiff = Math.abs(time - lastSavedProgressRef.current);
              const now = Date.now();
              if (now - lastSavedTimeRef.current > 10000 || timeDiff > 5) {
                lastSavedTimeRef.current = now;
                lastSavedProgressRef.current = time;
                saveProgressLocal(time, duration);
              }
            }
          }}
          onPlay={(e) => {
            setIsPaused(false);
            setIsMuted(e.currentTarget.muted || e.currentTarget.volume === 0);
          }}
          onPause={(e) => {
            setIsPaused(true);
            const time = e.currentTarget.currentTime;
            const duration = e.currentTarget.duration;
            if (time > 0) {
              saveProgressLocal(time, duration);
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

            // Attempt autoplay with audio first, fallback to muted if blocked
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
      )}

      {/* Server 2 Iframe element removed */}

      {/* Active Dub/Subtitle Indicators in bottom left corner */}
      {activeServer === 'server1' && s1StreamUrl && !s1Fetching && !s1Error && (
        <div
          className={`absolute bottom-6 left-6 z-25 flex gap-2 text-[10px] font-black text-neutral-300 pointer-events-none transition-opacity duration-300 ${userActive || isPaused ? 'opacity-100' : 'opacity-0'
            }`}
        >
          {s1SelectedAudio !== 'none' && (
            <div className="flex items-center gap-1.5 px-2 py-1 bg-neutral-900/80 border border-red-500/20 rounded-lg backdrop-blur-md">
              <Volume2 className="w-3.5 h-3.5 text-red-500" />
              <span>{s1AudioVersions.find(t => t.subject_id === s1SelectedAudio || t.id === s1SelectedAudio)?.label || 'DUB'}</span>
            </div>
          )}
        </div>
      )}



      {/* Floating Unmute Button Overlay */}
      {activeServer === 'server1' && s1StreamUrl && !s1Fetching && !s1Error && isMuted && (
        <button
          onClick={() => {
            if (videoRef.current) {
              videoRef.current.muted = false;
              if (videoRef.current.volume === 0) {
                videoRef.current.volume = 0.5;
              }
              setIsMuted(false);
            }
          }}
          className="absolute bottom-24 right-6 z-30 flex items-center gap-2 px-4 py-2.5 rounded-xl bg-red-600/90 hover:bg-red-500 border border-red-500/30 text-white text-[10px] font-black uppercase tracking-widest backdrop-blur-md shadow-[0_8px_32px_rgba(220,38,38,0.3)] hover:scale-105 active:scale-95 transition-all duration-300 animate-pulse-glow cursor-pointer"
        >
          <Volume2 className="w-4 h-4 text-white animate-bounce" />
          <span>Click to Unmute</span>
        </button>
      )}
    </div>
  );
}
