import React from 'react';
import { Server, Shield, Clock, Film, Tv, Settings, Code, Globe } from 'lucide-react';

export const metadata = {
  title: 'Premium Iframe Stream Player',
  description: 'Self-hosted premium video stream player designed for cross-origin iframe embedding.',
};

export default function HomePage() {
  return (
    <div className="min-h-screen bg-[#07070a] text-neutral-200 font-sans flex flex-col items-center justify-center p-6 sm:p-12 md:p-24 selection:bg-red-600 selection:text-white">
      {/* Background Decorative Glows */}
      <div className="absolute top-1/4 left-1/4 -translate-x-1/2 -translate-y-1/2 w-96 h-96 rounded-full bg-red-600/10 blur-[120px] pointer-events-none" />
      <div className="absolute bottom-1/4 right-1/4 translate-x-1/2 translate-y-1/2 w-96 h-96 rounded-full bg-red-800/10 blur-[120px] pointer-events-none" />

      <main className="relative max-w-4xl w-full flex flex-col gap-10 z-10">
        {/* Header */}
        <div className="flex flex-col gap-3 text-center sm:text-left border-b border-white/5 pb-8">
          <div className="flex items-center justify-center sm:justify-start gap-2.5 mb-2">
            <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse shadow-[0_0_10px_rgba(239,68,68,0.8)]" />
            <span className="text-[10px] font-black uppercase tracking-[0.3em] text-red-500">
              Streaming Infrastructure
            </span>
          </div>
          <h1 className="text-4xl sm:text-5xl font-black text-white tracking-tight uppercase leading-none">
            Iframe Video Player
          </h1>
          <p className="text-sm text-neutral-400 max-w-2xl leading-relaxed mt-2">
            A secure, proxy-rotating video player system designed to be embedded in external websites via iframes. Automatically fetches streams, processes subtitles, and resolves multi-language audio dubs directly in the viewport.
          </p>
        </div>

        {/* Integration Guides */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Movie Embed */}
          <div className="glass-panel p-6 rounded-3xl flex flex-col gap-4 border border-white/5 hover:border-white/10 transition-all duration-300">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-red-950/40 border border-red-500/20 rounded-2xl text-red-500">
                <Film className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-white uppercase tracking-wider">Movie Player</h3>
                <span className="text-[10px] text-neutral-400 font-medium">mydomain/movie/[tmdb_id]</span>
              </div>
            </div>
            
            <div className="flex flex-col gap-2">
              <span className="text-[10px] font-extrabold text-neutral-400 uppercase tracking-widest">HTML Embed Snippet</span>
              <pre className="bg-black/70 p-3.5 rounded-2xl border border-white/5 text-[10px] font-mono text-red-400 overflow-x-auto leading-relaxed scroll-container">
{`<iframe
  src="https://yourdomain.com/movie/550"
  width="100%"
  height="100%"
  allowFullScreen
  frameBorder="0"
  allow="autoplay; encrypted-media; fullscreen"
/>`}
              </pre>
            </div>
          </div>

          {/* TV Show Embed */}
          <div className="glass-panel p-6 rounded-3xl flex flex-col gap-4 border border-white/5 hover:border-white/10 transition-all duration-300">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-red-950/40 border border-red-500/20 rounded-2xl text-red-500">
                <Tv className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-white uppercase tracking-wider">TV Series Player</h3>
                <span className="text-[10px] text-neutral-400 font-medium">mydomain/tv/[tmdb_id]/[season]/[episode]</span>
              </div>
            </div>
            
            <div className="flex flex-col gap-2">
              <span className="text-[10px] font-extrabold text-neutral-400 uppercase tracking-widest">HTML Embed Snippet</span>
              <pre className="bg-black/70 p-3.5 rounded-2xl border border-white/5 text-[10px] font-mono text-red-400 overflow-x-auto leading-relaxed scroll-container">
{`<iframe
  src="https://yourdomain.com/tv/1399/1/1"
  width="100%"
  height="100%"
  allowFullScreen
  frameBorder="0"
  allow="autoplay; encrypted-media; fullscreen"
/>`}
              </pre>
            </div>
          </div>
        </div>

        {/* Feature Grid */}
        <div className="flex flex-col gap-4">
          <h2 className="text-xs font-black uppercase tracking-[0.2em] text-white">Engine Specifications</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-neutral-900/40 border border-white/5 p-4 rounded-2xl flex flex-col gap-2">
              <Server className="w-5 h-5 text-red-500" />
              <h4 className="text-[11px] font-bold text-white uppercase tracking-wider">Proxy Rotation</h4>
              <p className="text-[10px] text-neutral-500 leading-normal">Shuffles 15 parallel proxies to bypass region limits.</p>
            </div>
            <div className="bg-neutral-900/40 border border-white/5 p-4 rounded-2xl flex flex-col gap-2">
              <Globe className="w-5 h-5 text-red-500" />
              <h4 className="text-[11px] font-bold text-white uppercase tracking-wider">Language Dubs</h4>
              <p className="text-[10px] text-neutral-500 leading-normal">Switches audio tracks directly inside the player overlay.</p>
            </div>
            <div className="bg-neutral-900/40 border border-white/5 p-4 rounded-2xl flex flex-col gap-2">
              <Clock className="w-5 h-5 text-red-500" />
              <h4 className="text-[11px] font-bold text-white uppercase tracking-wider">Progress Lock</h4>
              <p className="text-[10px] text-neutral-500 leading-normal">Saves playback position locally and resumes automatically.</p>
            </div>
            <div className="bg-neutral-900/40 border border-white/5 p-4 rounded-2xl flex flex-col gap-2">
              <Shield className="w-5 h-5 text-red-500" />
              <h4 className="text-[11px] font-bold text-white uppercase tracking-wider">Hotlink Protection</h4>
              <p className="text-[10px] text-neutral-500 leading-normal">Blocks direct API scrapes, only allowing verified iframes.</p>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-white/5 pt-6 text-[10px] font-bold text-neutral-500 uppercase tracking-widest">
          <span>Version 1.0.0</span>
          <span>© {new Date().getFullYear()} Stream Engine</span>
        </div>
      </main>
    </div>
  );
}
