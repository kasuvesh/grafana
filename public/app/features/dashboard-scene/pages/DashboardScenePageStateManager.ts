import { locationUtil } from '@grafana/data';
import { getBackendSrv, isFetchError, locationService } from '@grafana/runtime';
import { updateNavIndex } from 'app/core/actions';
import { StateManagerBase } from 'app/core/services/StateManagerBase';
import { backendSrv } from 'app/core/services/backend_srv';
import { dashboardLoaderSrv } from 'app/features/dashboard/services/DashboardLoaderSrv';
import { getDashboardSrv } from 'app/features/dashboard/services/DashboardSrv';
import { buildNavModel } from 'app/features/folders/state/navModel';
import { store } from 'app/store/store';
import { DashboardDTO, DashboardRoutes } from 'app/types';

import { PanelEditor } from '../panel-edit/PanelEditor';
import { DashboardScene } from '../scene/DashboardScene';
import { buildNewDashboardSaveModel } from '../serialization/buildNewDashboardSaveModel';
import { transformSaveModelToScene } from '../serialization/transformSaveModelToScene';

export interface DashboardScenePageState {
  dashboard?: DashboardScene;
  panelEditor?: PanelEditor;
  isLoading?: boolean;
  loadError?: string;
}

export const DASHBOARD_CACHE_TTL = 2000;

/** Only used by cache in loading home in DashboardPageProxy and initDashboard (Old arch), can remove this after old dashboard arch is gone */
export const HOME_DASHBOARD_CACHE_KEY = '__grafana_home_uid__';

interface DashboardCacheEntry {
  dashboard: DashboardDTO;
  ts: number;
}

export interface LoadDashboardOptions {
  uid: string;
  route: DashboardRoutes;
  urlFolderUid?: string;
}

export class DashboardScenePageStateManager extends StateManagerBase<DashboardScenePageState> {
  private cache: Record<string, DashboardScene> = {};
  // This is a simplistic, short-term cache for DashboardDTOs to avoid fetching the same dashboard multiple times across a short time span.
  private dashboardCache: Map<string, DashboardCacheEntry> = new Map();

  // To eventualy replace the fetchDashboard function from Dashboard redux state management.
  // For now it's a simplistic version to support Home and Normal dashboard routes.
  public async fetchDashboard({ uid, route, urlFolderUid }: LoadDashboardOptions) {
    const cacheKey = route === DashboardRoutes.Home ? HOME_DASHBOARD_CACHE_KEY : uid;
    const cachedDashboard = this.getFromCache(cacheKey);

    if (cachedDashboard) {
      return cachedDashboard;
    }

    let rsp: DashboardDTO | undefined;

    try {
      switch (route) {
        case DashboardRoutes.New:
          rsp = buildNewDashboardSaveModel(urlFolderUid);
          break;
        case DashboardRoutes.Home:
          rsp = await getBackendSrv().get('/api/dashboards/home');

          // If user specified a custom home dashboard redirect to that
          if (rsp?.redirectUri) {
            const newUrl = locationUtil.stripBaseFromUrl(rsp.redirectUri);
            locationService.replace(newUrl);
            return null;
          }

          if (rsp?.meta) {
            rsp.meta.canSave = false;
            rsp.meta.canShare = false;
            rsp.meta.canStar = false;
          }

          break;
        default:
          rsp = await dashboardLoaderSrv.loadDashboard('db', '', uid);

          if (route === DashboardRoutes.Embedded) {
            rsp.meta.isEmbedded = true;
          }
      }

      if (rsp) {
        if (rsp.meta.url && route !== DashboardRoutes.Embedded) {
          const dashboardUrl = locationUtil.stripBaseFromUrl(rsp.meta.url);
          const currentPath = locationService.getLocation().pathname;
          if (dashboardUrl !== currentPath) {
            // Spread current location to persist search params used for navigation
            locationService.replace({
              ...locationService.getLocation(),
              pathname: dashboardUrl,
            });
            console.log('not correct url correcting', dashboardUrl, currentPath);
          }
        }

        // Populate nav model in global store according to the folder
        await this.initNavModel(rsp);

        // Do not cache new dashboards
        if (uid) {
          this.dashboardCache.set(uid, { dashboard: rsp, ts: Date.now() });
        } else if (route === DashboardRoutes.Home) {
          this.dashboardCache.set(HOME_DASHBOARD_CACHE_KEY, { dashboard: rsp, ts: Date.now() });
        }
      }
    } catch (e) {
      // Ignore cancelled errors
      if (isFetchError(e) && e.cancelled) {
        return null;
      }

      console.error(e);
      throw e;
    }

    return rsp;
  }

  public async loadDashboard(options: LoadDashboardOptions) {
    try {
      const dashboard = await this.loadScene(options);
      dashboard.startUrlSync();

      this.setState({ dashboard: dashboard, isLoading: false });
    } catch (err) {
      this.setState({ isLoading: false, loadError: String(err) });
    }
  }

  private async loadScene(options: LoadDashboardOptions): Promise<DashboardScene> {
    const fromCache = this.cache[options.uid];
    if (fromCache) {
      return fromCache;
    }

    this.setState({ isLoading: true });

    const rsp = await this.fetchDashboard(options);

    if (rsp?.dashboard) {
      const scene = transformSaveModelToScene(rsp);

      if (options.uid) {
        this.cache[options.uid] = scene;
      }

      return scene;
    }

    throw new Error('Dashboard not found');
  }

  public getFromCache(uid: string) {
    const cachedDashboard = this.dashboardCache.get(uid);

    if (cachedDashboard && !this.hasExpired(cachedDashboard)) {
      return cachedDashboard.dashboard;
    }

    return null;
  }

  private hasExpired(entry: DashboardCacheEntry) {
    return Date.now() - entry.ts > DASHBOARD_CACHE_TTL;
  }

  private async initNavModel(dashboard: DashboardDTO) {
    // only the folder API has information about ancestors
    // get parent folder (if it exists) and put it in the store
    // this will be used to populate the full breadcrumb trail
    if (dashboard.meta.folderUid) {
      try {
        const folder = await backendSrv.getFolderByUid(dashboard.meta.folderUid);
        store.dispatch(updateNavIndex(buildNavModel(folder)));
      } catch (err) {
        console.warn('Error fetching parent folder', dashboard.meta.folderUid, 'for dashboard', err);
      }
    }
  }

  public clearState() {
    getDashboardSrv().setCurrent(undefined);
    this.setState({ dashboard: undefined, loadError: undefined, isLoading: false, panelEditor: undefined });
  }

  public setDashboardCache(uid: string, dashboard: DashboardDTO) {
    this.dashboardCache.set(uid, { dashboard, ts: Date.now() });
  }
}

let stateManager: DashboardScenePageStateManager | null = null;

export function getDashboardScenePageStateManager(): DashboardScenePageStateManager {
  if (!stateManager) {
    stateManager = new DashboardScenePageStateManager({});
  }

  return stateManager;
}
