import type * as T from './index-types';

// Non-electron platforms have no HTML renderer; callers fall back to HTML.
export const renderHtmlToPdf: T.RenderHtmlToPdf = async function () {
  return null;
};
