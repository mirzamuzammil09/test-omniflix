import React from 'react';
import VideoPlayer from '@/components/VideoPlayer';
import type { Metadata } from 'next';

interface TVPageProps {
  params: Promise<{
    id: string;
    season: string;
    episode: string;
  }>;
}

export async function generateMetadata({ params }: TVPageProps): Promise<Metadata> {
  const resolvedParams = await params;
  return {
    title: `Premium TV Player | TMDB ${resolvedParams.id} S${resolvedParams.season}E${resolvedParams.episode}`,
    description: 'Watch premium TV series episodes with multi-language dubs and subtitle synchronization directly in our player.',
    robots: { index: false, follow: false }
  };
}

export default async function TVPage({ params }: TVPageProps) {
  const resolvedParams = await params;
  
  return (
    <main className="w-full h-dvh bg-black overflow-hidden m-0 p-0 flex items-center justify-center">
      <VideoPlayer 
        tmdbId={resolvedParams.id} 
        type="tv" 
        season={Number(resolvedParams.season) || 1} 
        episode={Number(resolvedParams.episode) || 1} 
      />
    </main>
  );
}
