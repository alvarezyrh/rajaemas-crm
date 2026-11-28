import { Errors } from '../../core/errors.js';
import { fetchJson } from '../integrations/fetcher.js';

const FIELD_MASK = 'id,rating,userRatingCount,reviews,googleMapsUri';

function googleMapsUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      ['google.com', 'www.google.com', 'maps.google.com'].includes(url.hostname)
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function placeUrl(placeId) {
  return `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`;
}

export function createReviewsService({ branches, apiKey, logger, fetchPlace = fetchJson }) {
  return Object.freeze({
    async outlet(actor, branchId) {
      const branch = await branches.get(actor, branchId);
      if (!branch.googlePlaceId) {
        throw Errors.notImplemented('This outlet has no Google Place ID configured');
      }
      if (!apiKey) {
        throw Errors.notImplemented('Google Places is not configured on this server');
      }

      let place;
      try {
        place = await fetchPlace(placeUrl(branch.googlePlaceId), {
          headers: {
            'X-Goog-Api-Key': apiKey,
            'X-Goog-FieldMask': FIELD_MASK,
          },
        });
      } catch (err) {
        logger.error('reviews.fetch_failed', { err, branchId });
        throw Errors.unavailable('Google Places could not be reached');
      }

      return {
        branch: { id: branch.id, code: branch.code, name: branch.name },
        rating: place.rating ?? null,
        userRatingCount: place.userRatingCount ?? 0,
        googleMapsUri: googleMapsUrl(place.googleMapsUri),
        reviews: (place.reviews ?? []).map((review) => ({
          rating: review.rating ?? null,
          text: review.text?.text ?? review.originalText?.text ?? '',
          publishedAt: review.publishTime ?? null,
          author: review.authorAttribution?.displayName ?? null,
          authorUri: googleMapsUrl(review.authorAttribution?.uri),
          googleMapsUri: googleMapsUrl(review.googleMapsUri),
        })),
      };
    },
  });
}
