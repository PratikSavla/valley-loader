// SPDX-License-Identifier: AGPL-3.0-only
import { APP_NAME, COPYRIGHT, LICENSE_NAME, LICENSE_URL, SOURCE_URL } from '@shared/about';
import { ExternalLink } from './ExternalLink';

/** AGPL §5(d) notice: copyright, license, no warranty, and where to get the source. */
export function AboutSection() {
  return (
    <section className="card settings-section" aria-labelledby="about-title">
      <h2 id="about-title">About {APP_NAME}</h2>
      <p>
        {COPYRIGHT}. {APP_NAME} is free software, licensed under the <ExternalLink href={LICENSE_URL}>{LICENSE_NAME}</ExternalLink>.
      </p>
      <p className="muted">
        It comes with absolutely no warranty. You can redistribute and modify it under the terms of that license.
      </p>
      <p>
        <ExternalLink href={SOURCE_URL}>Source code</ExternalLink>
      </p>
      <p className="muted">
        Unofficial: not affiliated with Nexus Mods, ConcernedApe or the SMAPI project. Stardew Valley is a trademark of
        ConcernedApe LLC.
      </p>
    </section>
  );
}
