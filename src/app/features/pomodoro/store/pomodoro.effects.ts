import {Injectable} from '@angular/core';
import {Actions, Effect, ofType} from '@ngrx/effects';
import {SetCurrentTask, TaskActionTypes, ToggleStart, UnsetCurrentTask} from '../../tasks/store/task.actions';
import {filter, map, mapTo, tap, withLatestFrom} from 'rxjs/operators';
import {PomodoroService} from '../pomodoro.service';
import {PomodoroConfig} from '../../config/global-config.model';
import {
  FinishPomodoroSession,
  PausePomodoro,
  PomodoroActions,
  PomodoroActionTypes,
  StartPomodoro
} from './pomodoro.actions';
import {MatDialog} from '@angular/material/dialog';
import {DialogPomodoroBreakComponent} from '../dialog-pomodoro-break/dialog-pomodoro-break.component';
import {select, Store} from '@ngrx/store';
import {selectCurrentTaskId} from '../../tasks/store/task.selectors';
import {Observable} from 'rxjs';
import {NotifyService} from '../../../core/notify/notify.service';
import {IS_ELECTRON} from '../../../app.constants';
import {IPC} from '../../../../../electron/ipc-events.const';
import {ElectronService} from 'ngx-electron';
import {T} from '../../../t.const';
import {SnackService} from '../../../core/snack/snack.service';

const isEnabled = ([action, cfg, ...v]) => cfg && cfg.isEnabled;

@Injectable()
export class PomodoroEffects {
  currentTaskId$: Observable<string> = this._store$.pipe(select(selectCurrentTaskId));

  @Effect()
  playPauseOnCurrentUpdate$ = this._actions$.pipe(
    ofType(
      TaskActionTypes.SetCurrentTask,
      TaskActionTypes.UnsetCurrentTask,
    ),
    withLatestFrom(
      this._pomodoroService.cfg$,
      this._pomodoroService.isBreak$,
    ),
    filter(isEnabled),
    // don't update when on break and stop time tracking is active
    filter(([action, cfg, isBreak]: [SetCurrentTask | UnsetCurrentTask, PomodoroConfig, boolean]) =>
      !(isBreak && cfg.isStopTrackingOnBreak)),
    map(([action]): PomodoroActions => {
      // tslint:disable-next-line
      const payload = action['payload'];

      if (payload && action.type !== TaskActionTypes.UnsetCurrentTask) {
        return new StartPomodoro();
      } else {
        return new PausePomodoro({isBreakEndPause: false});
      }
    }),
  );


  @Effect()
  autoStartNextOnSessionStartIfNotAlready$ = this._actions$.pipe(
    ofType(PomodoroActionTypes.FinishPomodoroSession),
    withLatestFrom(
      this._pomodoroService.cfg$,
      this._pomodoroService.isBreak$,
      this.currentTaskId$,
    ),
    filter(isEnabled),
    filter(([action, cfg, isBreak, currentTaskId]: [FinishPomodoroSession, PomodoroConfig, boolean, string]) =>
      (!isBreak && !currentTaskId && !action.payload.isDontResume)
    ),
    mapTo(new ToggleStart()),
  );

  @Effect()
  stopPomodoro$ = this._actions$.pipe(
    ofType(PomodoroActionTypes.StopPomodoro),
    mapTo(new UnsetCurrentTask()),
  );

  @Effect()
  pauseTimeTrackingIfOptionEnabled$ = this._actions$.pipe(
    ofType(PomodoroActionTypes.FinishPomodoroSession),
    withLatestFrom(
      this._pomodoroService.cfg$,
      this._pomodoroService.isBreak$,
    ),
    filter(isEnabled),
    filter(([action, cfg, isBreak]: [FinishPomodoroSession, PomodoroConfig, boolean]) =>
      cfg.isStopTrackingOnBreak && isBreak),
    mapTo(new UnsetCurrentTask()),
  );

  @Effect({dispatch: false})
  playSessionDoneSoundIfEnabled$ = this._actions$.pipe(
    ofType(
      PomodoroActionTypes.PausePomodoro,
      PomodoroActionTypes.FinishPomodoroSession,
    ),
    withLatestFrom(
      this._pomodoroService.cfg$,
      this._pomodoroService.isBreak$,
    ),
    filter(isEnabled),
    filter(([action, cfg, isBreak]: [FinishPomodoroSession | PausePomodoro, PomodoroConfig, boolean]) => {
      return (action.type === PomodoroActionTypes.FinishPomodoroSession
        && (cfg.isPlaySound && isBreak) || (cfg.isPlaySoundAfterBreak && !cfg.isManualContinue && !isBreak))
        || (action.type === PomodoroActionTypes.PausePomodoro && action.payload.isBreakEndPause);
    }),
    tap(() => this._pomodoroService.playSessionDoneSound()),
  );

  @Effect()
  pauseTimeTrackingForPause$ = this._actions$.pipe(
    ofType(PomodoroActionTypes.PausePomodoro),
    withLatestFrom(
      this._pomodoroService.cfg$,
      this.currentTaskId$,
    ),
    filter(isEnabled),
    filter(([act, cfg, currentTaskId]) => !!currentTaskId),
    mapTo(new UnsetCurrentTask()),
  );

  @Effect({dispatch: false})
  openBreakDialog = this._actions$.pipe(
    ofType(PomodoroActionTypes.FinishPomodoroSession),
    withLatestFrom(
      this._pomodoroService.isBreak$,
    ),
    tap(([action, isBreak]: [FinishPomodoroSession, boolean]) => {
      if (isBreak) {
        this._matDialog.open(DialogPomodoroBreakComponent);
      }
    }),
  );

  @Effect({dispatch: false})
  sessionStartSnack$ = this._actions$.pipe(
    ofType(PomodoroActionTypes.FinishPomodoroSession),
    withLatestFrom(
      this._pomodoroService.isBreak$,
      this._pomodoroService.isManualPause$,
      this._pomodoroService.currentCycle$,
    ),
    tap(([action, isBreak, isPause, currentCycle]: [FinishPomodoroSession, boolean, boolean, number]) =>
      // TODO only notify if window is not currently focused
      this._notifyService.notifyDesktop({
        title: isBreak
          ? T.F.POMODORO.NOTIFICATION.BREAK_X_START
          : T.F.POMODORO.NOTIFICATION.SESSION_X_START,
        translateParams: {nr: `${currentCycle + 1}`}
      })),
    filter(([action, isBreak, isPause, currentCycle]: [FinishPomodoroSession, boolean, boolean, number]) =>
      !isBreak && !isPause
    ),
    tap(([action, isBreak, isPause, currentCycle]: [FinishPomodoroSession, boolean, boolean, number]) => {
      this._snackService.open({
        ico: 'timer',
        msg: T.F.POMODORO.NOTIFICATION.SESSION_X_START,
        translateParams: {nr: `${currentCycle + 1}`}
      });
    }),
  );

  @Effect({dispatch: false})
  setTaskBarIconProgress$: any = this._pomodoroService.sessionProgress$.pipe(
    filter(() => IS_ELECTRON),
    withLatestFrom(this._pomodoroService.cfg$),
    // we display pomodoro progress for pomodoro
    filter(([progress, cfg]: [number, PomodoroConfig]) => cfg && cfg.isEnabled),
    tap(([progress, cfg]) => {
      this._electronService.ipcRenderer.send(IPC.SET_PROGRESS_BAR, {progress});
    }),
  );


  constructor(
    private _pomodoroService: PomodoroService,
    private _actions$: Actions,
    private _notifyService: NotifyService,
    private _matDialog: MatDialog,
    private _electronService: ElectronService,
    private _snackService: SnackService,
    private _store$: Store<any>,
  ) {
  }
}
