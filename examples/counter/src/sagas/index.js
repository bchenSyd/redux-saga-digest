/* eslint-disable no-constant-condition */

import { put, call, fork, all, takeEvery, delay } from 'redux-saga/effects'
import { debug } from 'util';


export default function* rootSaga() {
  yield takeEvery('INCREMENT_ASYNC', function* () {
    // DANGER: takeEvery subscribe to redux store and will NEVER finish;
    //         if you click the button twice you will now have 2 subscribers to your redux store;
    yield takeEvery('SECOND', function* () { 
          console.log('******************  SECOND CAPTURED') // therefore you will see this message twice when you click the button for the second time;
    });
    yield put({ type: 'SECOND' })
  })
}