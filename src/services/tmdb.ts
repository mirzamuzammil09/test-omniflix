import {
  MovieOrTV,
  Genre,
  CastMember,
  Video,
  MovieDetails,
  TVEpisode,
  TVSeason,
  TVDetails,
  TMDBResponse,
} from './tmdb.types';

export { TMDB_IMAGE_BASE } from './tmdb.types';
export type {
  MovieOrTV,
  Genre,
  CastMember,
  Video,
  MovieDetails,
  TVEpisode,
  TVSeason,
  TVDetails,
  TMDBResponse,
};

const API_KEY = process.env.NEXT_PUBLIC_TMDB_API_KEY || '5b105eaa9e19fa225a50dedade4b8d16';
if (!API_KEY && typeof window === 'undefined') {
  console.warn('[TMDB Service] Warning: TMDB_API_KEY environment variable is not defined!');
}
const BASE_URL = 'https://api.tmdb.org/3';

// Checks if the error is a Next.js internal Dynamic Server Usage error.
function isDynamicServerError(err: any): boolean {
  return (
    err &&
    (err.digest === 'DYNAMIC_SERVER_USAGE' ||
      (err.message && err.message.includes('Dynamic server usage')) ||
      err.name === 'DynamicServerError')
  );
}

// Global in-memory cache to make edge-rendered TMDB requests blazingly fast by caching the Promise.
const tmdbCache = new Map<string, { promise: Promise<any>; expiry: number }>();

// Global fetch wrapper with standard error handling and dynamic ISR caching
function fetchFromTMDB<T>(endpoint: string, queryParams: Record<string, string | number | undefined> = {}, cacheSeconds = 86400): Promise<T> {
  const url = new URL(`${BASE_URL}/${endpoint}`);
  url.searchParams.append('api_key', API_KEY);
  
  // Format query parameters
  Object.entries(queryParams).forEach(([key, value]) => {
    if (value !== undefined) {
      url.searchParams.append(key, String(value));
    }
  });

  const cacheKey = url.toString();
  const now = Date.now();

  // Check in-memory cache first
  const cached = tmdbCache.get(cacheKey);
  if (cached && cached.expiry > now) {
    return cached.promise as Promise<T>;
  }

  // Create the promise for fetching
  const fetchPromise = (async () => {
    try {
      const res = await fetch(url.toString(), {
        next: { revalidate: cacheSeconds }, // Enable dynamic ISR caching globally
        headers: {
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(3000)
      });

      if (!res.ok) {
        throw new Error(`TMDB Fetch failed for path: ${endpoint}. Status: ${res.status}`);
      }

      return await res.json() as T;
    } catch (error: any) {
      // Clear this cache entry on failure so future requests can try again
      tmdbCache.delete(cacheKey);

      // Rethrow Next.js internal dynamic rendering control errors
      if (isDynamicServerError(error)) {
        throw error;
      }

      // Return stale cache as backup if it exists
      if (cached) {
        console.warn(`[TMDB Cache Fallback] Returning stale cache for ${endpoint} due to fetch error.`);
        return cached.promise;
      }
      
      console.error(`TMDB API Error:`, error);
      throw error;
    }
  })();

  // Cache the promise immediately
  tmdbCache.set(cacheKey, {
    promise: fetchPromise,
    expiry: now + cacheSeconds * 1000,
  });

  return fetchPromise;
}

// Helper to filter items that have already been released
const filterReleasedResults = <T extends { release_date?: string; first_air_date?: string }>(results: T[]): T[] => {
  const today = new Date();
  return (results || []).filter((item) => {
    const dateStr = item.release_date || item.first_air_date;
    if (!dateStr) return false;
    return new Date(dateStr) <= today;
  });
};

// API Methods
export const tmdb = {
  // 1. Trending Media
  getTrending: async (type: 'all' | 'movie' | 'tv' = 'all', timeWindow: 'day' | 'week' = 'week', page = 1) => {
    return fetchFromTMDB<TMDBResponse<MovieOrTV>>(`trending/${type}/${timeWindow}`, { page })
      .then((res) => ({
        ...res,
        results: filterReleasedResults(res.results),
      }))
      .catch((err) => {
        if (isDynamicServerError(err)) throw err;
        return { page, results: [], total_pages: 0, total_results: 0 };
      });
  },

  // 2. Movies listings
  getPopularMovies: async (page = 1) => {
    return fetchFromTMDB<TMDBResponse<MovieOrTV>>('movie/popular', { page })
      .then((res) => ({
        ...res,
        results: filterReleasedResults(res.results),
      }))
      .catch((err) => {
        if (isDynamicServerError(err)) throw err;
        return { page, results: [], total_pages: 0, total_results: 0 };
      });
  },

  getTopRatedMovies: async (page = 1) => {
    return fetchFromTMDB<TMDBResponse<MovieOrTV>>('movie/top_rated', { page })
      .then((res) => ({
        ...res,
        results: filterReleasedResults(res.results),
      }))
      .catch((err) => {
        if (isDynamicServerError(err)) throw err;
        return { page, results: [], total_pages: 0, total_results: 0 };
      });
  },

  getMovieDetails: async (id: number | string) => {
    return fetchFromTMDB<MovieDetails>(`movie/${id}`)
      .catch((err) => {
        if (isDynamicServerError(err)) throw err;
        return {} as MovieDetails;
      });
  },

  getMovieCredits: async (id: number | string) => {
    try {
      const data = await fetchFromTMDB<{ cast: CastMember[] }>(`movie/${id}/credits`);
      return data.cast || [];
    } catch (error) {
      if (isDynamicServerError(error)) throw error;
      return [];
    }
  },

  getMovieVideos: async (id: number | string) => {
    try {
      const data = await fetchFromTMDB<{ results: Video[] }>(`movie/${id}/videos`);
      return data.results || [];
    } catch (error) {
      if (isDynamicServerError(error)) throw error;
      return [];
    }
  },

  getMovieRecommendations: async (id: number | string, page = 1) => {
    return fetchFromTMDB<TMDBResponse<MovieOrTV>>(`movie/${id}/recommendations`, { page })
      .then((res) => ({
        ...res,
        results: filterReleasedResults(res.results),
      }))
      .catch((err) => {
        if (isDynamicServerError(err)) throw err;
        return { page, results: [], total_pages: 0, total_results: 0 };
      });
  },

  // 3. TV Series listings
  getPopularTV: async (page = 1) => {
    return fetchFromTMDB<TMDBResponse<MovieOrTV>>('tv/popular', { page })
      .then((res) => ({
        ...res,
        results: filterReleasedResults(res.results),
      }))
      .catch((err) => {
        if (isDynamicServerError(err)) throw err;
        return { page, results: [], total_pages: 0, total_results: 0 };
      });
  },

  getTopRatedTV: async (page = 1) => {
    return fetchFromTMDB<TMDBResponse<MovieOrTV>>('tv/top_rated', { page })
      .then((res) => ({
        ...res,
        results: filterReleasedResults(res.results),
      }))
      .catch((err) => {
        if (isDynamicServerError(err)) throw err;
        return { page, results: [], total_pages: 0, total_results: 0 };
      });
  },

  getTVDetails: async (id: number | string) => {
    return fetchFromTMDB<TVDetails>(`tv/${id}`)
      .then((res) => {
        if (res && res.seasons) {
          const today = new Date();
          res.seasons = res.seasons.filter((s) => {
            if (s.season_number <= 0) return false;
            if (!s.air_date) return false;
            return new Date(s.air_date) <= today;
          });
        }
        return res;
      })
      .catch((err) => {
        if (isDynamicServerError(err)) throw err;
        return {} as TVDetails;
      });
  },

  getTVExternalIds: async (id: number | string) => {
    return fetchFromTMDB<{ imdb_id?: string; tvdb_id?: number }>(`tv/${id}/external_ids`)
      .catch((err) => {
        if (isDynamicServerError(err)) throw err;
        return {} as { imdb_id?: string; tvdb_id?: number };
      });
  },

  getTVCredits: async (id: number | string) => {
    try {
      const data = await fetchFromTMDB<{ cast: CastMember[] }>(`tv/${id}/credits`);
      return data.cast || [];
    } catch (error) {
      if (isDynamicServerError(error)) throw error;
      return [];
    }
  },

  getTVVideos: async (id: number | string) => {
    try {
      const data = await fetchFromTMDB<{ results: Video[] }>(`tv/${id}/videos`);
      return data.results || [];
    } catch (error) {
      if (isDynamicServerError(error)) throw error;
      return [];
    }
  },

  getTVRecommendations: async (id: number | string, page = 1) => {
    return fetchFromTMDB<TMDBResponse<MovieOrTV>>(`tv/${id}/recommendations`, { page })
      .then((res) => ({
        ...res,
        results: filterReleasedResults(res.results),
      }))
      .catch((err) => {
        if (isDynamicServerError(err)) throw err;
        return { page, results: [], total_pages: 0, total_results: 0 };
      });
  },

  getTVSeasonDetails: async (tvId: number | string, seasonNumber: number) => {
    return fetchFromTMDB<TVSeason>(`tv/${tvId}/season/${seasonNumber}`)
      .then((res) => {
        if (res && res.episodes) {
          const today = new Date();
          res.episodes = res.episodes.filter((ep) => {
            if (!ep.air_date) return false;
            return new Date(ep.air_date) <= today;
          });
        }
        return res;
      })
      .catch((err) => {
        if (isDynamicServerError(err)) throw err;
        return {} as TVSeason;
      });
  },

  // 4. Genres listings
  getGenres: async (type: 'movie' | 'tv'): Promise<Genre[]> => {
    try {
      const data = await fetchFromTMDB<{ genres: Genre[] }>(`genre/${type}/list`);
      return data.genres || [];
    } catch (error) {
      if (isDynamicServerError(error)) throw error;
      return [];
    }
  },

  // 5. Global Multi-Search
  searchMulti: async (query: string, page = 1) => {
    return fetchFromTMDB<TMDBResponse<MovieOrTV>>('search/multi', { query, page }, 300)
      .then((res) => ({
        ...res,
        results: filterReleasedResults(res.results),
      }))
      .catch((err) => {
        if (isDynamicServerError(err)) throw err;
        return { page, results: [], total_pages: 0, total_results: 0 };
      });
  },

  // 6. Content Discover (by genre, sort, type)
  discoverContent: async (
    type: 'movie' | 'tv', 
    options: { with_genres?: string; sort_by?: string; page?: number; with_original_language?: string } = {}
  ) => {
    return fetchFromTMDB<TMDBResponse<MovieOrTV>>(`discover/${type}`, {
      with_genres: options.with_genres,
      sort_by: options.sort_by || 'popularity.desc',
      page: options.page || 1,
      with_original_language: options.with_original_language,
    })
      .then((res) => ({
        ...res,
        results: filterReleasedResults(res.results),
      }))
      .catch((err) => {
        if (isDynamicServerError(err)) throw err;
        return { page: options.page || 1, results: [], total_pages: 0, total_results: 0 };
      });
  },

  // 7. Get Japanese Anime
  getAnime: async (page = 1, type: 'all' | 'tv' | 'movie' = 'all') => {
    try {
      if (type === 'all') {
        const [tvResponse, movieResponse] = await Promise.all([
          fetchFromTMDB<TMDBResponse<MovieOrTV>>('discover/tv', {
            with_genres: '16', // Animation
            with_original_language: 'ja', // Japanese original language = Anime
            sort_by: 'popularity.desc',
            page,
          }),
          fetchFromTMDB<TMDBResponse<MovieOrTV>>('discover/movie', {
            with_genres: '16', // Animation
            with_original_language: 'ja',
            sort_by: 'popularity.desc',
            page,
          }),
        ]);

        const tvResults = (tvResponse.results || []).map(item => ({ ...item, media_type: 'tv' as const }));
        const movieResults = (movieResponse.results || []).map(item => ({ ...item, media_type: 'movie' as const }));
        
        // Merge and filter
        const combined = filterReleasedResults([...tvResults, ...movieResults])
          .sort((a, b) => (b.popularity || 0) - (a.popularity || 0));

        return {
          page,
          results: combined,
          total_pages: Math.min(Math.max(tvResponse.total_pages || 1, movieResponse.total_pages || 1), 500),
          total_results: combined.length,
        };
      } else {
        const response = await fetchFromTMDB<TMDBResponse<MovieOrTV>>(`discover/${type}`, {
          with_genres: '16',
          with_original_language: 'ja',
          sort_by: 'popularity.desc',
          page,
        });

        const filteredResults = filterReleasedResults((response.results || []).map(item => ({ ...item, media_type: type })));
        return {
          ...response,
          results: filteredResults,
          total_pages: Math.min(response.total_pages || 1, 500),
        };
      }
    } catch (error) {
      if (isDynamicServerError(error)) throw error;
      console.error('Error fetching anime:', error);
      return { page, results: [], total_pages: 0, total_results: 0 };
    }
  },

  // 8. Translations
  getTranslations: async (type: 'movie' | 'tv', id: number | string) => {
    return fetchFromTMDB<{ translations: { iso_639_1: string; english_name: string; name: string }[] }>(`${type}/${id}/translations`)
      .catch((err) => {
        if (isDynamicServerError(err)) throw err;
        return { translations: [] };
      });
  },
};
