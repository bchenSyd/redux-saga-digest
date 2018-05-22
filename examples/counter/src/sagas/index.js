/* eslint-disable no-constant-condition */

import { put, call, fork, all,  takeEvery, delay } from 'redux-saga/effects'
import { debug } from 'util';

function* test() {
  yield new Promise(resolve => {
    setTimeout(() => {
      resolve(true);
    }, 2000);
  });

  yield delay(1000);

  yield call(() => {
    console.log("I'm forked");
  })
}


export function* incrementAsync() {

  // > https://github.com/redux-saga/redux-saga/issues/1448#issuecomment-390896294
  // yield test(); yieldIterator better be replaced with `yield call(Generator)`
  yield call(test); // use the Call Effect form
  // or yield fork(test); // the newly forked task will become current task (root task) 's subtask, so that it won't be orphaned after the end of current workflow is reached;

  console.log('calling 1 is done')


  yield* test();
  console.log('calling 2 is done')
}

export default function* rootSaga() {
  yield takeEvery('INCREMENT_ASYNC', function* () {
    yield all([
      takeEvery('SECOND', function* () {
        yield put({ type: 'THIRD' });
      }),
      put({ type: 'SECOND' })
    ])
    console.log('done')
  })
}
