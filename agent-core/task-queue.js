'use strict';

const { CODES } = require('./errors');

function cancellationError(taskId) {
  const error = new Error(`Task "${taskId}" was cancelled`);
  error.name = 'AbortError';
  error.code = CODES.TASK_CANCELLED;
  error.taskId = taskId;
  return error;
}

function publicTask(task, active) {
  if (active) {
    return {
      task_id: task.taskId,
      started_at: task.startedAt
    };
  }
  return {
    task_id: task.taskId,
    queued_at: task.enqueuedAt
  };
}

class TaskQueue {
  constructor() {
    this._active = null;
    this._queued = [];
    this._taskIds = new Set();
  }

  enqueue(taskId, worker) {
    if (typeof taskId !== 'string' || taskId.trim() === '') {
      return Promise.reject(new TypeError('taskId must be a non-empty string'));
    }
    if (typeof worker !== 'function') {
      return Promise.reject(new TypeError('worker must be a function'));
    }
    if (this._taskIds.has(taskId)) {
      return Promise.reject(new Error(`Duplicate taskId: ${taskId}`));
    }

    const controller = new AbortController();
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const task = {
      taskId,
      worker,
      controller,
      enqueuedAt: new Date().toISOString(),
      startedAt: null,
      resolve: resolvePromise,
      reject: rejectPromise
    };

    this._taskIds.add(taskId);
    this._queued.push(task);
    this._startNext();
    return promise;
  }

  cancel(taskId) {
    if (this._active && this._active.taskId === taskId) {
      if (this._active.controller.signal.aborted) return false;
      this._active.controller.abort();
      return true;
    }

    const index = this._queued.findIndex((task) => task.taskId === taskId);
    if (index === -1) return false;

    const [task] = this._queued.splice(index, 1);
    this._taskIds.delete(task.taskId);
    task.controller.abort();
    task.reject(cancellationError(task.taskId));
    return true;
  }

  status() {
    return {
      active: this._active ? publicTask(this._active, true) : null,
      queued: this._queued.map((task) => publicTask(task, false))
    };
  }

  _startNext() {
    if (this._active || this._queued.length === 0) return;

    const task = this._queued.shift();
    task.startedAt = new Date().toISOString();
    this._active = task;

    Promise.resolve()
      .then(() => {
        if (task.controller.signal.aborted) {
          throw cancellationError(task.taskId);
        }
        return task.worker({
          signal: task.controller.signal,
          taskId: task.taskId
        });
      })
      .then(
        (value) => {
          const aborted = task.controller.signal.aborted;
          this._finish(task);
          if (aborted) {
            task.reject(cancellationError(task.taskId));
          } else {
            task.resolve(value);
          }
        },
        (error) => {
          const aborted = task.controller.signal.aborted;
          this._finish(task);
          if (aborted) {
            task.reject(cancellationError(task.taskId));
          } else {
            task.reject(error);
          }
        }
      );
  }

  _finish(task) {
    this._taskIds.delete(task.taskId);
    this._active = null;
    this._startNext();
  }
}

module.exports = { TaskQueue };
