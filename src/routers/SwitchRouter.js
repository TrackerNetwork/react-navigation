import pathToRegexp from 'path-to-regexp';

import invariant from '../utils/invariant';
import getScreenForRouteName from './getScreenForRouteName';
import createConfigGetter from './createConfigGetter';

import NavigationActions from '../NavigationActions';
import StackActions from './StackActions';
import validateRouteConfigMap from './validateRouteConfigMap';
import getNavigationActionCreators from './getNavigationActionCreators';

function isEmpty(obj) {
  if (!obj) return true;
  for (let key in obj) {
    return false;
  }
  return true;
}

const defaultActionCreators = (route, navStateKey) => ({});

function childrenUpdateWithoutSwitchingIndex(actionType) {
  return [
    NavigationActions.SET_PARAMS,
    // Todo: make SwitchRouter not depend on StackActions..
    StackActions.COMPLETE_TRANSITION,
  ].includes(actionType);
}

export default (routeConfigs, config = {}) => {
  // Fail fast on invalid route definitions
  validateRouteConfigMap(routeConfigs);

  const order = config.order || Object.keys(routeConfigs);
  const pathsByRouteNames = { ...config.paths };
  const paths = [];
  const getCustomActionCreators =
    config.getCustomActionCreators || defaultActionCreators;
  const initialRouteParams = config.initialRouteParams;
  const initialRouteName = config.initialRouteName || order[0];
  const backBehavior = config.backBehavior || 'none';
  const shouldBackNavigateToInitialRoute = backBehavior === 'initialRoute';
  const resetOnBlur = config.hasOwnProperty('resetOnBlur')
    ? config.resetOnBlur
    : true;
  const initialRouteIndex = order.indexOf(initialRouteName);
  const childRouters = {};
  order.forEach(routeName => {
    const routeConfig = routeConfigs[routeName];
    if (!pathsByRouteNames[routeName]) {
      pathsByRouteNames[routeName] =
        typeof routeConfig.path === 'string' ? routeConfig.path : routeName;
    }
    let pathPattern = pathsByRouteNames[routeName];

    childRouters[routeName] = null;
    const screen = getScreenForRouteName(routeConfigs, routeName);
    if (screen.router) {
      childRouters[routeName] = screen.router;
    }

    let matchExact = !!pathPattern && !childRouters[routeName];

    const keys = [];
    let re, toPath, priority;
    if (typeof pathPattern === 'string') {
      // pathPattern may be either a string or a regexp object according to path-to-regexp docs.
      re = pathToRegexp(pathPattern, keys);
      toPath = pathToRegexp.compile(pathPattern);
      priority = 0;
    } else {
      // for wildcard match
      re = pathToRegexp('*', keys);
      toPath = () => '';
      matchExact = true;
      priority = -1;
    }
    if (!matchExact) {
      const wildcardRe = pathToRegexp(`${pathPattern}/*`, keys);
      re = new RegExp(`(?:${re.source})|(?:${wildcardRe.source})`);
    }

    pathsByRouteNames[routeName] = { re, keys, toPath, priority };
    paths.push([routeName, pathsByRouteNames[routeName]]);
  });

  if (initialRouteIndex === -1) {
    throw new Error(
      `Invalid initialRouteName '${initialRouteName}'.` +
        `Should be one of ${order.map(n => `"${n}"`).join(', ')}`
    );
  }

  function resetChildRoute(routeName) {
    const params =
      routeName === initialRouteName ? initialRouteParams : undefined;
    const childRouter = childRouters[routeName];
    if (childRouter) {
      const childAction = NavigationActions.init();
      return {
        ...childRouter.getStateForAction(childAction),
        key: routeName,
        routeName,
        params,
      };
    }
    return {
      key: routeName,
      routeName,
      params,
    };
  }

  return {
    getInitialState() {
      const routes = order.map(resetChildRoute);
      return {
        routes,
        index: initialRouteIndex,
        isTransitioning: false,
      };
    },

    getNextState(prevState, possibleNextState) {
      if (!prevState) {
        return possibleNextState;
      }

      let nextState;
      if (prevState.index !== possibleNextState.index && resetOnBlur) {
        const prevRouteName = prevState.routes[prevState.index].routeName;
        const nextRoutes = [...possibleNextState.routes];
        nextRoutes[prevState.index] = resetChildRoute(prevRouteName);

        return {
          ...possibleNextState,
          routes: nextRoutes,
        };
      } else {
        nextState = possibleNextState;
      }

      return nextState;
    },

    getActionCreators(route, stateKey) {
      return {
        ...getNavigationActionCreators(route, stateKey),
        ...getCustomActionCreators(route, stateKey),
      };
    },

    getStateForAction(action, inputState) {
      let prevState = inputState ? { ...inputState } : inputState;
      let state = inputState || this.getInitialState();
      let activeChildIndex = state.index;

      // NOTE(brentvatne): this seems weird... why are we merging these
      // params into child routes?
      // ---------------------------------------------------------------
      // Merge any params from the action into all the child routes
      const { params } = action;
      if (params) {
        state.routes = state.routes.map(route => ({
          ...route,
          params: {
            ...route.params,
            ...params,
            ...(route.routeName === initialRouteName
              ? initialRouteParams
              : null),
          },
        }));
      }

      // Let the current child handle it
      const activeChildLastState = state.routes[state.index];
      const activeChildRouter = childRouters[order[state.index]];
      if (activeChildRouter) {
        const activeChildState = activeChildRouter.getStateForAction(
          action,
          activeChildLastState
        );
        if (!activeChildState && inputState) {
          return null;
        }
        if (activeChildState && activeChildState !== activeChildLastState) {
          const routes = [...state.routes];
          routes[state.index] = activeChildState;
          return this.getNextState(prevState, {
            ...state,
            routes,
          });
        }
      }

      // Handle tab changing. Do this after letting the current tab try to
      // handle the action, to allow inner children to change first
      const isBackEligible =
        action.key == null || action.key === activeChildLastState.key;
      if (action.type === NavigationActions.BACK) {
        if (isBackEligible && shouldBackNavigateToInitialRoute) {
          activeChildIndex = initialRouteIndex;
        } else {
          return state;
        }
      }

      let didNavigate = false;
      if (action.type === NavigationActions.NAVIGATE) {
        didNavigate = !!order.find((childId, i) => {
          if (childId === action.routeName) {
            activeChildIndex = i;
            return true;
          }
          return false;
        });
        if (didNavigate) {
          const childState = state.routes[activeChildIndex];
          const childRouter = childRouters[action.routeName];
          let newChildState;

          if (action.action) {
            newChildState = childRouter
              ? childRouter.getStateForAction(action.action, childState)
              : null;
          } else if (!action.action && !childRouter && action.params) {
            newChildState = {
              ...childState,
              params: {
                ...(childState.params || {}),
                ...action.params,
              },
            };
          }

          if (newChildState && newChildState !== childState) {
            const routes = [...state.routes];
            routes[activeChildIndex] = newChildState;
            return this.getNextState(prevState, {
              ...state,
              routes,
              index: activeChildIndex,
            });
          } else if (
            !newChildState &&
            state.index === activeChildIndex &&
            prevState
          ) {
            return null;
          }
        }
      }

      if (action.type === NavigationActions.SET_PARAMS) {
        const key = action.key;
        const lastRoute = state.routes.find(route => route.key === key);
        if (lastRoute) {
          const params = {
            ...lastRoute.params,
            ...action.params,
          };
          const routes = [...state.routes];
          routes[state.routes.indexOf(lastRoute)] = {
            ...lastRoute,
            params,
          };
          return this.getNextState(prevState, {
            ...state,
            routes,
          });
        }
      }

      if (activeChildIndex !== state.index) {
        return this.getNextState(prevState, {
          ...state,
          index: activeChildIndex,
        });
      } else if (didNavigate && !inputState) {
        return state;
      } else if (didNavigate) {
        return { ...state };
      }

      // Let other children handle it and switch to the first child that returns a new state
      let index = state.index;
      let routes = state.routes;
      order.find((childId, i) => {
        const childRouter = childRouters[childId];
        if (i === index) {
          return false;
        }
        let childState = routes[i];
        if (childRouter) {
          childState = childRouter.getStateForAction(action, childState);
        }
        if (!childState) {
          index = i;
          return true;
        }
        if (childState !== routes[i]) {
          routes = [...routes];
          routes[i] = childState;
          index = i;
          return true;
        }
        return false;
      });

      // Nested routers can be updated after switching children with actions such as SET_PARAMS
      // and COMPLETE_TRANSITION.
      // NOTE: This may be problematic with custom routers because we whitelist the actions
      // that can be handled by child routers without automatically changing index.
      if (childrenUpdateWithoutSwitchingIndex(action.type)) {
        index = state.index;
      }

      if (index !== state.index || routes !== state.routes) {
        return this.getNextState(prevState, {
          ...state,
          index,
          routes,
        });
      }
      return state;
    },

    getComponentForState(state) {
      const routeName = state.routes[state.index].routeName;
      invariant(
        routeName,
        `There is no route defined for index ${state.index}. Check that
        that you passed in a navigation state with a valid tab/screen index.`
      );
      const childRouter = childRouters[routeName];
      if (childRouter) {
        return childRouter.getComponentForState(state.routes[state.index]);
      }
      return getScreenForRouteName(routeConfigs, routeName);
    },

    getComponentForRouteName(routeName) {
      return getScreenForRouteName(routeConfigs, routeName);
    },

    getPathAndParamsForState(state) {
      const route = state.routes[state.index];
      const routeName = route.routeName;
      const screen = getScreenForRouteName(routeConfigs, routeName);
      const subPath = pathsByRouteNames[routeName].toPath(route.params);
      let path = subPath;
      let params = route.params;
      if (screen && screen.router) {
        const stateRoute = route;
        // If it has a router it's a navigator.
        // If it doesn't have router it's an ordinary React component.
        const child = screen.router.getPathAndParamsForState(stateRoute);
        path = subPath ? `${subPath}/${child.path}` : child.path;
        params = child.params ? { ...params, ...child.params } : params;
      }
      return {
        path,
        params,
      };
    },

    /**
     * Gets an optional action, based on a relative path and query params.
     *
     * This will return null if there is no action matched
     */
    getActionForPathAndParams(pathToResolve, inputParams) {
      // If the path is empty (null or empty string)
      // just return the initial route action
      if (!pathToResolve) {
        return NavigationActions.navigate({
          routeName: initialRouteName,
          params: inputParams,
        });
      }

      const [pathNameToResolve, queryString] = pathToResolve.split('?');

      // Attempt to match `pathNameToResolve` with a route in this router's
      // routeConfigs
      let matchedRouteName;
      let pathMatch;
      let pathMatchKeys;

      // eslint-disable-next-line no-restricted-syntax
      for (const [routeName, path] of paths) {
        const { re, keys } = path;
        pathMatch = re.exec(pathNameToResolve);
        if (pathMatch && pathMatch.length) {
          pathMatchKeys = keys;
          matchedRouteName = routeName;
          break;
        }
      }

      // We didn't match -- return null
      if (!matchedRouteName) {
        // If the path is empty (null or empty string)
        // just return the initial route action
        if (!pathToResolve) {
          return NavigationActions.navigate({
            routeName: initialRouteName,
          });
        }
        return null;
      }

      // reduce the items of the query string. parent params are
      // may be overridden by query params. query params may
      // be overridden by path params
      const queryParams = !isEmpty(inputParams)
        ? inputParams
        : (queryString || '').split('&').reduce((result, item) => {
            if (item !== '') {
              const nextResult = result || {};
              const [key, value] = item.split('=');
              nextResult[key] = value;
              return nextResult;
            }
            return result;
          }, inputParams);

      // reduce the matched pieces of the path into the params
      // of the route. `params` is null if there are no params.
      const params = pathMatch.slice(1).reduce((result, matchResult, i) => {
        const key = pathMatchKeys[i];
        if (key.asterisk || !key) {
          return result;
        }
        const nextResult = result || inputParams || {};
        const paramName = key.name;

        let decodedMatchResult;
        try {
          decodedMatchResult = decodeURIComponent(matchResult);
        } catch (e) {
          // ignore `URIError: malformed URI`
        }

        nextResult[paramName] = decodedMatchResult || matchResult;
        return nextResult;
      }, queryParams);

      // Determine nested actions:
      // If our matched route for this router is a child router,
      // get the action for the path AFTER the matched path for this
      // router
      let nestedAction;
      let nestedQueryString = queryString ? '?' + queryString : '';
      if (childRouters[matchedRouteName]) {
        nestedAction = childRouters[matchedRouteName].getActionForPathAndParams(
          pathMatch.slice(pathMatchKeys.length).join('/') + nestedQueryString,
          params
        );
        if (!nestedAction) {
          return null;
        }
      }

      return NavigationActions.navigate({
        routeName: matchedRouteName,
        ...(params ? { params } : {}),
        ...(nestedAction ? { action: nestedAction } : {}),
      });
    },

    getScreenOptions: createConfigGetter(
      routeConfigs,
      config.navigationOptions
    ),
  };
};
