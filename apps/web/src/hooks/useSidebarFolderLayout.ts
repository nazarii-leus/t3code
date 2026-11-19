import type { SidebarFolderEntry } from "@t3tools/contracts";

import {
  usePrimarySettings,
  usePrimarySettingsAvailable,
  useUpdatePrimarySettings,
} from "./useSettings";

/** Folder order, icons and sort live in the primary environment's server settings. */
export function useSidebarFolderLayout() {
  const layout = usePrimarySettings((settings) => settings.sidebarFolders);
  const available = usePrimarySettingsAvailable();
  const updateSettings = useUpdatePrimarySettings();
  return {
    layout,
    available,
    save: (next: ReadonlyArray<SidebarFolderEntry>) => updateSettings({ sidebarFolders: next }),
  };
}
