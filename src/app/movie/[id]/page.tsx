import React from 'react';
import VideoPlayer from '@/components/VideoPlayer';
import type { Metadata } from 'next';

interface MoviePageProps {
  params: Promise<{
    id: string;
  }>;
}

export async function generateMetadata({ params }: MoviePageProps): Promise<Metadata> {
  const resolvedParams = await params;
  return {
    title: `Premium Movie Player | TMDB ${resolvedParams.id}`,
    description: 'Watch premium movies with multi-language dubs and subtitle synchronization directly in our player.',
    robots: { index: false, follow: false }
  };
}

export default async function MoviePage({ params }: MoviePageProps) {
  const resolvedParams = await params;
  return (
    <main className="w-screen h-screen bg-black overflow-hidden m-0 p-0 flex items-center justify-center">
      <VideoPlayer tmdbId={resolvedParams.id} type="movie" />
    </main>
  );
}
