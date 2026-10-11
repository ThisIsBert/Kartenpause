import { operatePolygons } from './polygon-operation.js';
self.onmessage=({data})=>{
  try{self.postMessage({result:operatePolygons(data.objects,data.operation)});}
  catch(error){self.postMessage({error:error.message});}
};
