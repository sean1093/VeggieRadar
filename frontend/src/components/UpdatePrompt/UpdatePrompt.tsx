import React from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';

/**
 * The one line that tells a running app a newer build is waiting.
 *
 * The service worker registers with `registerType: 'prompt'`, so a new version
 * installs and then sits in `waiting` until this prompt is tapped. Reloading on
 * its own is the wrong trade for this audience: they read prices standing in
 * front of a stall, and a drawer that vanishes mid-number is worse than an app
 * that is one deploy behind. 稍後 dismisses the line without discarding the
 * worker — it takes over on the next natural load either way.
 */
const UpdatePrompt: React.FC = () => {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  if (!needRefresh) return null;

  return (
    <div
      role="status"
      className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-paper/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-sm"
    >
      <div className="mx-auto flex max-w-2xl items-center justify-between gap-3 px-4 py-3">
        <p className="text-sm text-ink">已更新，重新整理看新版</p>
        <div className="flex shrink-0 items-center gap-4">
          <button
            onClick={() => updateServiceWorker(true)}
            className="text-sm text-sage transition-colors hover:text-ink"
          >
            重新整理
          </button>
          <button
            onClick={() => setNeedRefresh(false)}
            className="text-sm text-stone transition-colors hover:text-ink"
          >
            稍後
          </button>
        </div>
      </div>
    </div>
  );
};

export default UpdatePrompt;
