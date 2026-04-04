// entrypoints/sidepanel/components/Header.tsx
// Logo placeholder + title. Clean, minimal header.

import React from 'react';

export default function Header() {
    return (
        <header className="lco-dash-header">
            <div className="lco-dash-logo" aria-label="Saar logo placeholder" />
            <div className="lco-dash-header-text">
                <h1 className="lco-dash-title">Saar</h1>
                <p className="lco-dash-subtitle">AI Usage Coach</p>
            </div>
        </header>
    );
}
