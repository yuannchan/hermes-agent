import { useStore } from '@nanostores/react'
import { type ReactElement, useEffect } from 'react'

import { VersionHero } from '@/components/update-status'
import { VersionDetails } from '@/components/version-details'
import { $desktopVersion, refreshDesktopVersion } from '@/store/updates'

import { SettingsContent } from './primitives'
import { UninstallSection } from './uninstall-section'
import { useSettingDeepLink } from './use-setting-deep-link'

interface AboutSettingsProps {
  subpage?: string
}

/** Holo does not carry an official update channel. About is version + local uninstall only. */
export function AboutSettings({ subpage }: AboutSettingsProps = {}): ReactElement {
  useSettingDeepLink('about', page => subpage === undefined || page === subpage)

  if (subpage === 'uninstall') {
    return (
      <SettingsContent>
        <UninstallSection />
      </SettingsContent>
    )
  }

  return <AppAbout includeUninstall={subpage === undefined} />
}

interface AppAboutProps {
  includeUninstall: boolean
}

function AppAbout({ includeUninstall }: AppAboutProps): ReactElement {
  const version = useStore($desktopVersion)

  useEffect((): void => {
    void refreshDesktopVersion()
  }, [])

  return (
    <SettingsContent>
      <VersionHero version={version} />
      <div className="mx-auto mt-4 w-full max-w-2xl">
        {version && <VersionDetails version={version} />}
        {includeUninstall && <UninstallSection />}
      </div>
    </SettingsContent>
  )
}
