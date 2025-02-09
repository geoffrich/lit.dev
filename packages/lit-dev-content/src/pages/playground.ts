/**
 * @license
 * Copyright 2021 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import '@material/mwc-button';
import '@material/mwc-snackbar';
import 'playground-elements/playground-ide.js';
import '../components/litdev-example-controls.js';
import '../components/litdev-playground-change-guard.js';
import '../components/litdev-playground-share-button.js';
import '../components/litdev-playground-download-button.js';
import '../components/litdev-error-notifier.js';
import {
  getCodeLanguagePreference,
  CODE_LANGUAGE_CHANGE,
} from '../code-language-preference.js';
import {getGist} from '../github/github-gists.js';
import {GitHubError} from '../github/github-util.js';
import {Snackbar} from '@material/mwc-snackbar';
import {encodeSafeBase64, decodeSafeBase64} from '../util/safe-base64.js';
import {compactPlaygroundFile} from '../util/compact-playground-file.js';
import {modEnabled} from '../mods.js';
import {LitDevError, showError} from '../errors.js';
import {gistToPlayground} from '../util/gist-conversion.js';

interface CompactProjectFile {
  name: string;
  content: string;
  hidden?: true;
}

// TODO(aomarks) This whole thing should probably be a custom element.
window.addEventListener('DOMContentLoaded', () => {
  const $ = document.body.querySelector.bind(document.body);
  const project = $('playground-project')!;
  const shareButton = $('#shareButton')!;
  const shareSnackbar = $('#shareSnackbar')! as Snackbar;
  const playgroundPreview = $('playground-preview')!;

  // TODO(aomarks) A quite gross and fragile loose coupling! This entire module
  // needs to be refactored, probably into one or two custom elements.
  const newShareButton = $('litdev-playground-share-button');
  const githubApiUrl = newShareButton?.githubApiUrl ?? '';
  if (newShareButton) {
    newShareButton.getProjectFiles = () => project.files;

    // Clicks made on the playground-preview iframe will be handled entirely by
    // the iframe window, and don't propagate to the host window. That means
    // that the normal behavior where the share flyout detects clicks outside of
    // itself in order to close won't work, since it will never see the click
    // event. To work around this, we temporarily disable pointer-events on the
    // preview, so that clicks go to our host window instead.
    newShareButton.addEventListener('opened', () => {
      playgroundPreview.style.pointerEvents = 'none';
    });
    newShareButton.addEventListener('closed', () => {
      playgroundPreview.style.pointerEvents = 'unset';
    });
  } else {
    console.error('Missing litdev-playground-share-button');
  }

  const share = async () => {
    const files = (project.files ?? []).map(compactPlaygroundFile);
    const base64 = encodeSafeBase64(JSON.stringify(files));
    window.location.hash = '#project=' + base64;
    await navigator.clipboard.writeText(window.location.toString());
    shareSnackbar.open = true;
  };

  shareButton.addEventListener('click', share);

  const downloadButton = $('litdev-playground-download-button');
  if (downloadButton) {
    downloadButton.getProjectFiles = () => project.files;
  } else {
    console.error('Missing litdev-playground-download-button');
  }

  const loadBase64 = (
    base64: string
  ): Array<CompactProjectFile> | undefined => {
    if (base64) {
      try {
        const json = decodeSafeBase64(base64);
        try {
          return JSON.parse(json) as Array<CompactProjectFile>;
        } catch {
          console.error('Invalid JSON in URL', JSON.stringify(json));
        }
      } catch {
        console.error('Invalid project base64 in URL');
      }
    }
    return undefined;
  };

  const loadGist = async (
    gistId: string
  ): Promise<Array<CompactProjectFile>> => {
    const gist = await getGist(gistId, {apiBaseUrl: githubApiUrl});
    if (newShareButton) {
      newShareButton.activeGist = gist;
    }
    return gistToPlayground(gist.files).map(compactPlaygroundFile);
  };

  const syncStateFromUrlHash = async () => {
    const hash = window.location.hash;
    const params = new URLSearchParams(hash.slice(1));
    let urlFiles: Array<CompactProjectFile> | undefined;
    const gist = params.get('gist');
    const base64 = params.get('project');
    if (newShareButton && newShareButton.activeGist?.id !== gist) {
      // We're about to switch to a new gist, or to something that's not a gist
      // at all (a pre-made sample or a base64 project). Either way, the active
      // gist is now outdated.
      newShareButton.activeGist = undefined;
    }
    if (gist) {
      try {
        urlFiles = await loadGist(gist);
      } catch (error: unknown) {
        if (error instanceof GitHubError && error.status === 404) {
          error = new LitDevError({
            heading: 'Gist not found',
            message: 'The given GitHub gist could not be found.',
            stack: (error as Error).stack,
          });
        }
        // TODO(aomarks) Use @showErrors decorator after refactoring this into a
        // component.
        showError(error);
      }
    } else if (base64) {
      urlFiles = loadBase64(base64);
    }
    $('.exampleItem.active')?.classList.remove('active');

    if (urlFiles) {
      hideCodeLanguageSwitch();
      project.config = {
        extends: '/samples/base.json',
        files: Object.fromEntries(
          urlFiles.map(({name, content, hidden}) => [name, {content, hidden}])
        ),
      };
    } else {
      showCodeLanguageSwitch();
      let sample = 'examples/hello-world';
      const urlSample = params.get('sample');
      if (urlSample?.match(/^[a-zA-Z0-9_\-\/]+$/)) {
        sample = urlSample;
      }
      const samplesRoot =
        getCodeLanguagePreference() === 'ts' ? '/samples' : '/samples/js';
      project.projectSrc = `${samplesRoot}/${sample}/project.json`;

      const link = $(`.exampleItem[data-sample="${sample}"]`);
      if (link) {
        link.classList.add('active');
        // Wait for the drawer to upgrade and render before scrolling.
        await customElements.whenDefined('litdev-drawer');
        requestAnimationFrame(() => {
          scrollToCenter(link, document.querySelector('#exampleContent')!);
        });
      }
    }
  };

  syncStateFromUrlHash();
  window.addEventListener('hashchange', syncStateFromUrlHash);
  window.addEventListener(CODE_LANGUAGE_CHANGE, syncStateFromUrlHash);

  // Trigger URL sharing when Control-s or Command-s is pressed.
  if (!modEnabled('gists')) {
    let controlDown = false;
    let commandDown = false;
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Control') {
        controlDown = true;
      } else if (event.key === 'Meta') {
        commandDown = true;
      } else if (event.key === 's' && (controlDown || commandDown)) {
        share();
        event.preventDefault(); // Don't trigger "Save page as"
      }
    });
    window.addEventListener('keyup', (event) => {
      if (event.key === 'Control') {
        controlDown = false;
      } else if (event.key === 'Meta') {
        commandDown = false;
      }
    });
    window.addEventListener('blur', () => {
      controlDown = false;
      commandDown = false;
    });
  }
});

const exampleControls = document.body.querySelector('litdev-example-controls');

/**
 * Set the opacity of the TypeScript/JavaScript language switch.
 *
 * When a Playground is comes from a base64-encoded project in the URL (i.e.
 * through the "Share" button), it's not possible to automatically translate
 * between JS and TS forms. Only pre-built TS samples have a generated JS
 * version available.
 */
const hideCodeLanguageSwitch = () => {
  if (exampleControls) {
    exampleControls.hideCodeLanguageSwitch = true;
  }
};

const showCodeLanguageSwitch = () => {
  if (exampleControls) {
    exampleControls.hideCodeLanguageSwitch = false;
  }
};

/**
 * Note we don't use scrollIntoView() because it also steals focus.
 */
const scrollToCenter = (target: Element, parent: Element) => {
  const parentRect = parent.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  if (
    targetRect.bottom > parentRect.bottom ||
    targetRect.top < parentRect.top
  ) {
    parent.scroll({
      top: targetRect.top - parentRect.top - parentRect.height / 2,
    });
  }
};
