export default async function handler(req,res){
 if(req.method!=="POST") return res.status(405).json({error:"Method not allowed"});
 try{
  const {prompt,style="Realistic",ratio="1:1"}=req.body||{};
  if(!prompt) return res.status(400).json({error:"Prompt is required"});
  const token=process.env.HF_TOKEN;
  if(!token) return res.status(500).json({error:"HF_TOKEN is not configured"});
  const full=`${prompt}. Visual style: ${style}. Aspect ratio: ${ratio}. High quality, detailed, polished artwork.`;
  const response=await fetch("https://router.huggingface.co/fal-ai/fal-ai/flux/schnell",{
    method:"POST",
    headers:{"Authorization":`Bearer ${token}`,"Content-Type":"application/json"},
    body:JSON.stringify({prompt:full,image_size:ratio==="16:9"?"landscape_16_9":ratio==="9:16"?"portrait_16_9":ratio==="4:5"?"portrait_4_3":"square_hd"})
  });
  if(!response.ok) return res.status(response.status).json({error:"AI provider request failed. Check your Hugging Face token and available credits."});
  const data=await response.json();
  const url=data?.images?.[0]?.url || data?.image?.url || data?.url;
  if(!url) return res.status(502).json({error:"No image URL returned by the provider."});
  return res.status(200).json({image:url});
 }catch(e){return res.status(500).json({error:"Server error: "+e.message})}
}