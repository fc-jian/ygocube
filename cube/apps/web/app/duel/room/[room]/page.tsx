import {StandaloneRoom} from '@/components/duel/StandaloneRoom';
export default function Page({params}:{params:{room:string}}){return <StandaloneRoom room={params.room}/>}
