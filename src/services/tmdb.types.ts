export const TMDB_IMAGE_BASE = {
  original: 'https://image.tmdb.org/t/p/original',
  backdrop: 'https://image.tmdb.org/t/p/w1280',
  poster: 'https://image.tmdb.org/t/p/w500',
  profile: 'https://image.tmdb.org/t/p/w185',
  logo: 'https://image.tmdb.org/t/p/w200',
};

// Interface definitions for strict TypeScript type-safety
export interface MovieOrTV {
  id: number;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  media_type?: 'movie' | 'tv';
  release_date?: string;
  first_air_date?: string;
  vote_average: number;
  vote_count: number;
  genre_ids?: number[];
  popularity: number;
  origin_country?: string[];
  original_language: string;
}

export interface Genre {
  id: number;
  name: string;
}

export interface CastMember {
  id: number;
  name: string;
  character: string;
  profile_path: string | null;
  order: number;
}

export interface Video {
  id: string;
  key: string;
  name: string;
  site: string;
  type: string;
  official: boolean;
}

export interface MovieDetails extends MovieOrTV {
  genres: Genre[];
  runtime: number | null;
  tagline: string | null;
  budget: number;
  revenue: number;
  status: string;
  imdb_id?: string | null;
}

export interface TVEpisode {
  id: number;
  name: string;
  overview: string;
  episode_number: number;
  season_number: number;
  air_date: string | null;
  still_path: string | null;
  vote_average: number;
  runtime?: number;
}

export interface TVSeason {
  id: number;
  name: string;
  overview: string;
  season_number: number;
  episode_count: number;
  air_date: string | null;
  poster_path: string | null;
  episodes?: TVEpisode[];
}

export interface TVDetails extends MovieOrTV {
  genres: Genre[];
  number_of_seasons: number;
  number_of_episodes: number;
  seasons: TVSeason[];
  tagline: string | null;
  status: string;
  episode_run_time?: number[];
}

export interface TMDBResponse<T> {
  page: number;
  results: T[];
  total_pages: number;
  total_results: number;
}
