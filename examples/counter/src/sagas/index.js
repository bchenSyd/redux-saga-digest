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
  yield put({type:'SECOND'})
  console.log('worker saga is done')
}

export default function* rootSaga() {
  /* takeEvery = Fork(()=>{
          yield take('INCREMENT_ASYNC ');
          yield* worker();
  })*/
  yield fork(incrementAsync)
  console.log('root sage done;')
}
