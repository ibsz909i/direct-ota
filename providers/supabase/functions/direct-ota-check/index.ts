import {service} from '../_shared/service.ts';
import {createCheckHandler} from '../_shared/handlers.ts';
const dependencies=service();
Deno.serve(createCheckHandler(dependencies));
